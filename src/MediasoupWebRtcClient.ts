import {
    ClientEmitter,
    Codec,
    RtpHeader,
    SSRCs,
    VideoStream,
    WebRtcClient,
} from "spacebar-webrtc-types";
import { VoiceRoom } from "./VoiceRoom";
import { EventEmitter } from "node:events";
import {
    Consumer,
    Producer,
    RtpCodecCapability,
    RtpHeaderExtension,
    RtpHeaderExtensionUri,
    Transport,
} from "mediasoup/node/lib/types";

export class MediasoupWebRtcClient implements WebRtcClient<any> {
    videoStream?: VideoStream | undefined;
    websocket: any;
    user_id: string;
    voiceRoomId: string;
    webrtcConnected: boolean;
    emitter: ClientEmitter;

    public room?: VoiceRoom;
    public isStopped?: boolean;
    public transport?: Transport;
    public codecs?: Codec[];
    public codecCapabilities?: RtpCodecCapability[];
    public headerExtensions?: RtpHeader[];
    public audioProducer?: Producer;
    public videoProducer?: Producer;
    public consumers?: Consumer[];
    public incomingSSRCS?: SSRCs;

    constructor(
        userId: string,
        roomId: string,
        websocket: any,
        room: VoiceRoom
    ) {
        this.user_id = userId;
        this.voiceRoomId = roomId;
        this.websocket = websocket;
        this.room = room;
        this.webrtcConnected = false;
        this.isStopped = false;
        this.emitter = new EventEmitter();
        this.consumers = [];
    }

    initIncomingSSRCs(ssrcs: SSRCs): void {
        this.incomingSSRCS = ssrcs;
    }

    getIncomingStreamSSRCs(): SSRCs {
        return {
            audio_ssrc: this.incomingSSRCS?.audio_ssrc,
            video_ssrc: this.isProducingVideo()
                ? this.incomingSSRCS?.video_ssrc
                : 0,
            rtx_ssrc: this.isProducingVideo()
                ? this.incomingSSRCS?.rtx_ssrc
                : 0,
        };
    }

    getOutgoingStreamSSRCsForUser(user_id: string): SSRCs {
        const otherClient = this.room?.getClientById(user_id);

        if (!otherClient) {
            return {};
        }

        const audioProducerId = otherClient.audioProducer?.id;
        const videoProducerId = otherClient.videoProducer?.id;

        const audioConsumer = this.consumers?.find(
            (consumer) => consumer.producerId === audioProducerId
        );
        const videoConsumer = this.consumers?.find(
            (consumer) => consumer.producerId === videoProducerId
        );

        return {
            audio_ssrc: audioConsumer?.rtpParameters.encodings?.find(
                (y) => y !== undefined
            )?.ssrc,
            video_ssrc: videoConsumer?.rtpParameters.encodings?.find(
                (y) => y !== undefined
            )?.ssrc,
            rtx_ssrc: videoConsumer?.rtpParameters.encodings?.find(
                (y) => y !== undefined
            )?.rtx?.ssrc,
        };
    }

    isProducingAudio(): boolean {
        return !!this.audioProducer;
    }

    isProducingVideo(): boolean {
        return !!this.videoProducer;
    }

    async publishTrack(type: "audio" | "video", ssrc: SSRCs): Promise<void> {
        if (!this.webrtcConnected || !this.transport) return;

        if (type === "audio" && !this.isProducingAudio()) {
            this.audioProducer = await this.transport.produce({
                kind: "audio",
                rtpParameters: {
                    codecs:
                        this.codecCapabilities
                            ?.filter((codec) => codec.kind === "audio")
                            .map((codec) => {
                                const {
                                    mimeType,
                                    clockRate,
                                    channels,
                                    rtcpFeedback,
                                    parameters,
                                } = codec;

                                return {
                                    mimeType,
                                    clockRate,
                                    channels,
                                    rtcpFeedback,
                                    parameters,
                                    payloadType:
                                        codec.preferredPayloadType ?? 111,
                                };
                            }) ?? [],
                    encodings: [
                        {
                            ssrc: ssrc.audio_ssrc,
                            maxBitrate: 64000,
                            codecPayloadType:
                                this.codecCapabilities?.find(codec => codec.kind === "audio")
                                    ?.preferredPayloadType ?? 111,
                        },
                    ],
                    // headerExtensions: this.headerExtensions?.map((header) => {
                    // 	return { id: header.id, uri: header.uri as RtpHeaderExtensionUri };
                    // }),
                },
                paused: false,
            });
        }

        if (type === "video" && !this.isProducingVideo()) {
            this.videoProducer = await this.transport.produce({
                kind: "video",
                rtpParameters: {
                    codecs:
                        this.codecCapabilities
                            ?.filter((codec) => codec.kind === "video")
                            .map((codec) => {
                                const {
                                    mimeType,
                                    clockRate,
                                    channels,
                                    rtcpFeedback,
                                    parameters,
                                } = codec;

                                return {
                                    mimeType,
                                    clockRate,
                                    channels,
                                    rtcpFeedback,
                                    parameters,
                                    payloadType:
                                        codec.preferredPayloadType ?? 102,
                                };
                            }) ?? [],
                    encodings: [
                        {
                            ssrc: ssrc.video_ssrc,
                            rtx: { ssrc: ssrc.rtx_ssrc! },
                            //scalabilityMode: "L1T1",
                            //scaleResolutionDownBy: 1,
                            //maxBitrate: 2500000,
                            //rid: stream.rid,
                            codecPayloadType:
                                this.codecCapabilities?.find(codec => codec.kind === "video")?.preferredPayloadType ?? 102,
                            //dtx: true,
                        },
                    ],
                    headerExtensions: this.headerExtensions
                        ?.filter(
                            (header) =>
                                header.uri === "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay" ||
								header.uri === "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time" ||
								header.uri === "urn:ietf:params:rtp-hdrext:toffset" ||
								header.uri === "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"
                        )
                        .map((header) => {
                            return {
                                id: header.id,
                                uri: header.uri as RtpHeaderExtensionUri,
                            };
                        }),
                },
                paused: false,
            });
        }
    }

    stopPublishingTrack(type: "audio" | "video"): void {
        if (!this.room) return;

        const producer =
            type === "audio" ? this.audioProducer : this.videoProducer;

        for (const client of this.room.clients.values()) {
            const consumers = client.consumers?.filter(
                (consumer) => consumer.producerId === producer?.id
            );

            consumers?.forEach((consumer) => {
                consumer.close();
                const index = client.consumers?.indexOf(consumer);
                if (typeof index === "number" && index != -1)
                    client.consumers?.splice(index, 1);
            });
        }

        // close the existing producer, if any
        producer?.close();

        if (type === "audio") this.audioProducer = undefined;
        else this.videoProducer = undefined;
    }

    async subscribeToTrack(
        user_id: string,
        type: "audio" | "video"
    ): Promise<void> {
        if (!this.webrtcConnected || !this.transport) return;

        const client = this.room?.getClientById(user_id);

        if (!client) return;

        const producer =
            type === "audio" ? client.audioProducer : client.videoProducer;

        if (!producer) return;

        let existingConsumer = this.consumers?.find(
            (x) => x.producerId === producer?.id
        );

        if (existingConsumer) return;

        const consumer = await this.transport.consume({
            producerId: producer.id,
            rtpCapabilities: {
                codecs: this.codecCapabilities,
                headerExtensions:
                    this.headerExtensions?.map((header) => {
                        return {
                            preferredId: header.id,
                            uri: header.uri as RtpHeaderExtensionUri,
                            kind: type,
                        };
                    }) ?? [],
            },
            paused: type === "video",
            appData: {
                user_id: client.user_id,
            },
        });

        if (type === "video") {
            setTimeout(async () => {
                await consumer.resume();
            }, 2000);
        }

        this.consumers?.push(consumer);
    }

    unSubscribeFromTrack(user_id: string, type: "audio" | "video"): void {
        const client = this.room?.getClientById(user_id);

        if (!client) return;

        const producer =
            type === "audio" ? client.audioProducer : client.videoProducer;

        if (!producer) return;

        const consumer = this.consumers?.find(
            (c) => c.producerId === producer.id
        );

        if (!consumer) return;

        consumer.close();
        const index = this.consumers?.indexOf(consumer);
        if (typeof index === "number" && index != -1)
            this.consumers?.splice(index, 1);
    }

    isSubscribedToTrack(user_id: string, type: "audio" | "video"): boolean {
        const client = this.room?.getClientById(user_id);

        if (!client) return false;

        const producer =
            type === "audio" ? client.audioProducer : client.videoProducer;

        if (!producer) return false;

        const consumer = this.consumers?.find(
            (c) => c.producerId === producer.id
        );

        if (consumer) return true;

        return false;
    }
}
