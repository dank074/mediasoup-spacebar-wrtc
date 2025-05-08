import * as mediasoup from "mediasoup";
import { types as MediaSoupTypes } from "mediasoup";
import { AppData, Router, RtpHeaderExtension } from "mediasoup/node/lib/types";
import {
    Codec,
    RtpHeader,
    SignalingDelegate,
    WebRtcClient,
} from "spacebar-webrtc-types";
import { VoiceRoom } from "./VoiceRoom";
import { MediasoupWebRtcClient } from "./MediasoupWebRtcClient";
import { SDPInfo } from "semantic-sdp";

export interface RouterType {
    router: MediaSoupTypes.Router;
    worker: MediaSoupTypes.Worker<AppData>;
}

export class MediasoupSignalingDelegate implements SignalingDelegate {
    private _workers: MediaSoupTypes.Worker<AppData>[] = [];
    private _rooms: Map<string, VoiceRoom> = new Map();
    private nextWorkerIdx = 0;
    private _ip: string;

    async start(
        public_ip: string,
        portMin: number,
        portMax: number
    ): Promise<void> {
        this._ip = public_ip;
        const numWorkers = 2;

        for (let i = 0; i < numWorkers; i++) {
            const worker = await mediasoup.createWorker({
                logLevel: "debug",
                logTags: [
                    "info",
                    "ice",
                    "dtls",
                    "rtp",
                    "srtp",
                    "rtcp",
                    "rtx",
                    "bwe",
                    "score",
                    "simulcast",
                    "svc",
                    "sctp",
                ],
                rtcMinPort: portMin,
                rtcMaxPort: portMax,
                //disableLiburing: true,
            });

            worker.on("died", () => {
                console.error(
                    "mediasoup Worker died, exiting  in 2 seconds... [pid:%d]",
                    worker.pid
                );

                setTimeout(() => process.exit(1), 2000);
            });

            this._workers.push(worker);
        }
    }

    async join<T>(
        roomId: string,
        userId: string,
        ws: T,
        type: "guild-voice" | "dm-voice" | "stream"
    ): Promise<WebRtcClient<T>> {
        // if this is guild-voice or dm-voice, make sure user isn't already in a room of those types
        // user can be in many simultanous go live stream rooms though (can be in a voice channel and watching a stream for example, or watching multiple streams)
        const rooms =
            type === "stream"
                ? []
                : Array.from(this.rooms.values()).filter(
                      (room) =>
                          room.type === "dm-voice" ||
                          room.type === "guild-voice"
                  );
        let existingClient: WebRtcClient<T> | undefined;

        for (const room of rooms) {
            let result = room.getClientById(userId);
            if (result) {
                existingClient = result;
                break;
            }
        }

        if (existingClient) {
            console.log("client already connected, disconnect..");
            this.onClientClose(existingClient);
        }

        const room = await this.getOrCreateRoom(roomId, type)!;

        const client = new MediasoupWebRtcClient(userId, roomId, ws, room);

        room.onClientJoin(client);

        return client;
    }

    async onOffer<T>(
        client: WebRtcClient<T>,
        sdpOffer: string,
        codecs: Codec[]
    ): Promise<{ sdp: string; selectedVideoCodec: string }> {
        const room = this._rooms.get(client.voiceRoomId);

        if (!room) {
            console.error(
                "error, client sent an offer but has not authenticated"
            );
            Promise.reject();
        }

        const offer = SDPInfo.parse("m=audio\n" + sdpOffer);

        const rtpHeaders: RtpHeader[] = Array.from(
            offer.medias[0].extensions.entries()
        ).map(([id, uri]) => {
            return { uri, id };
        });

        const transport = await room!.router.router.createWebRtcTransport({
            //listenIps: [{ ip: this.ip }],
            listenInfos: [{ ip: "0.0.0.0", announcedAddress: this.ip, protocol: "udp" }],
            enableUdp: true,
            //maxIncomingBitrate: 2500000,
            initialAvailableOutgoingBitrate: 2500000,
        });

        room?.onClientOffer(client, transport, codecs, rtpHeaders);

        const remoteDTLS = offer.getDTLS().plain();

        await transport.connect({
            dtlsParameters: {
                fingerprints: [
                    {
                        algorithm:
                            remoteDTLS.hash as MediaSoupTypes.FingerprintAlgorithm,
                        value: remoteDTLS.fingerprint,
                    },
                ],
                role: "client",
            },
        });

        client.webrtcConnected = true;
        client.emitter.emit("connected");

        const iceParameters = transport!.iceParameters;
        const iceCandidates = transport!.iceCandidates;
        const iceCandidate = iceCandidates[0];
        const dltsParamters = transport!.dtlsParameters;
        const fingerprint = dltsParamters.fingerprints.find(
            (x) => x.algorithm === "sha-256"
        )!;

        const sdpAnswer =
            `m=audio ${iceCandidate.port} ICE/SDP\n` +
            `a=fingerprint:sha-256 ${fingerprint.value}\n` +
            `c=IN IP4 ${iceCandidate.ip}\n` +
            `a=rtcp:${iceCandidate.port}\n` +
            `a=ice-ufrag:${iceParameters.usernameFragment}\n` +
            `a=ice-pwd:${iceParameters.password}\n` +
            `a=fingerprint:sha-256 ${fingerprint.value}\n` +
            `a=candidate:1 1 ${iceCandidate.protocol.toUpperCase()} ${
                iceCandidate.priority
            } ${iceCandidate.ip} ${iceCandidate.port} typ ${
                iceCandidate.type
            }\n`;

        return { sdp: sdpAnswer, selectedVideoCodec: "H264" };
    }

    onClientClose<T>(client: WebRtcClient<T>): void {
        this._rooms.get(client.voiceRoomId)?.onClientLeave(client);
    }

    updateSDP(offer: string): void {
        throw new Error("Method not implemented.");
    }

    getClientsForRtcServer<T>(rtcServerId: string): Set<WebRtcClient<T>> {
        if (!this._rooms.has(rtcServerId)) {
            return new Set();
        }

        return new Set(this._rooms.get(rtcServerId)?.clients.values())!;
    }

    stop(): Promise<void> {
        return Promise.resolve();
    }

    get ip(): string {
        return this._ip;
    }

    get port(): number {
        return 9999; // idk
    }

    get rooms(): Map<string, VoiceRoom> {
        return this._rooms;
    }

    getNextWorker() {
        const worker = this._workers[this.nextWorkerIdx];

        if (++this.nextWorkerIdx === this._workers.length)
            this.nextWorkerIdx = 0;

        return worker;
    }

    async getOrCreateRoom(
        roomId: string,
        type: "guild-voice" | "dm-voice" | "stream"
    ) {
        if (!this._rooms.has(roomId)) {
            const worker = this.getNextWorker();
            const router = await worker.createRouter({
                mediaCodecs: MEDIA_CODECS,
            });

            const data = {
                router,
                worker,
            };

            const room = new VoiceRoom(roomId, type, this, data);
            this._rooms.set(roomId, room);
            return room;
        }

        return this._rooms.get(roomId)!;
    }
}

export const MEDIA_CODECS: MediaSoupTypes.RtpCodecCapability[] = [
    {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
        rtcpFeedback: [{ type: "nack" }, { type: "transport-cc" }],
        parameters: {
            minptime: 10,
            usedtx: 1,
            useinbandfec: 1,
        },
        preferredPayloadType: 111,
    },
    {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "x-google-max-bitrate": 2500,
            "x-google-start-bitrate": 2500,
        },
        rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "ccm", parameter: "fir" },
            { type: "goog-remb" },
            { type: "transport-cc" },
        ],
        preferredPayloadType: 102,
    },
    /*
    {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        preferredPayloadType: 101,
      }, */
];
