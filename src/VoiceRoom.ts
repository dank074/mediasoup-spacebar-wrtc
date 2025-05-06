import { RtpCodecCapability, Transport } from "mediasoup/node/lib/types";
import { MediasoupSignalingDelegate, RouterType } from "./MediasoupSignalingDelegate";
import { MediasoupWebRtcClient } from "./MediasoupWebRtcClient";
import { Codec, RtpHeader } from "spacebar-webrtc-types";
import { RtpHeaderExtensionUri } from "mediasoup/node/lib/fbs/rtp-parameters";

export class VoiceRoom {
    private _clients: Map<string, MediasoupWebRtcClient>;
    private _id: string;
    private _sfu: MediasoupSignalingDelegate;
    private _type: "guild-voice" | "dm-voice" | "stream";
    private _router: RouterType;

    constructor(
        id: string,
        type: "guild-voice" | "dm-voice" | "stream",
        sfu: MediasoupSignalingDelegate,
        router: RouterType
    ) {
        this._id = id;
        this._type = type;
        this._clients = new Map();
        this._sfu = sfu;
        this._router = router;
    }

    onClientJoin = (client: MediasoupWebRtcClient) => {
        // do shit here
        this._clients.set(client.user_id, client);
    };

    onClientOffer = (client: MediasoupWebRtcClient, transport: Transport, codecs: Codec[], rtpHeaders: RtpHeader[]) => {
        client.transport = transport;
        client.codecs = codecs;
        client.headerExtensions = rtpHeaders.filter(header => ['urn:ietf:params:rtp-hdrext:sdes:mid', 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id', 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id', 'http://tools.ietf.org/html/draft-ietf-avtext-framemarking-07', 'urn:ietf:params:rtp-hdrext:framemarking', 'urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'urn:3gpp:video-orientation', 'urn:ietf:params:rtp-hdrext:toffset', 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time', 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay'].includes(header.uri));
        const supportedCodecs: RtpCodecCapability[] = [
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
                preferredPayloadType:
                    codecs?.find((val) => val.name == "opus")?.payload_type ??
                    111,
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
                },
                rtcpFeedback: [
                    { type: "nack" },
                    { type: "nack", parameter: "pli" },
                    { type: "ccm", parameter: "fir" },
                    { type: "goog-remb" },
                    { type: "transport-cc" },
                ],
                preferredPayloadType:
                    codecs?.find((val) => val.name == "H264")?.payload_type ??
                    102,
            },
            {
                kind: "video",
                mimeType: "video/rtx",
                clockRate: 90000,
                parameters: {
                    apt:
                        codecs?.find((val) => val.name == "H264")
                            ?.payload_type ?? 102,
                },
                preferredPayloadType:
                    codecs?.find((val) => val.name == "H264")
                        ?.rtx_payload_type ?? 103,
            },
        ];

        client.codecCapabilities = supportedCodecs;
    }

    onClientLeave = (client: MediasoupWebRtcClient) => {
        console.log("stopping client");
        this._clients.delete(client.user_id);

        // stop the client
        if (!client.isStopped) {
            client.isStopped = true;

            for (const otherClient of this.clients.values()) {
                if (otherClient.user_id === client.user_id) continue;

                // close any consumers of closing client producers
                otherClient.consumers?.forEach((consumer) => {
                    if (
                        client?.audioProducer?.id === consumer.producerId ||
                        client?.videoProducer?.id === consumer.producerId
                    ) {
                        console.log("[WebRTC] closing consumer", consumer.id);
                        consumer.close();
                    }
                });
            }

            client.consumers?.forEach((consumer) => consumer.close());
            client.audioProducer?.close();
            client.videoProducer?.close();

            client.transport?.close();
            client.room = undefined;
            client.audioProducer = undefined;
            client.videoProducer = undefined;
            client.consumers = []
            client.transport = undefined;
            client.websocket = undefined;
            client.emitter.removeAllListeners();
        }
    };

    get clients(): Map<string, MediasoupWebRtcClient> {
        return this._clients;
    }

    getClientById = (id: string) => {
        return this._clients.get(id);
    };

    get id(): string {
        return this._id;
    }

    get type(): "guild-voice" | "dm-voice" | "stream" {
        return this._type;
    }

    get router(): RouterType {
        return this._router;
    }
}