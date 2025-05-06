import { RtpCodecCapability, Transport } from "mediasoup/node/lib/types";
import {
    MEDIA_CODECS,
    MediasoupSignalingDelegate,
    RouterType,
} from "./MediasoupSignalingDelegate";
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

    onClientOffer = (
        client: MediasoupWebRtcClient,
        transport: Transport,
        codecs: Codec[],
        rtpHeaders: RtpHeader[]
    ) => {
        client.transport = transport;
        client.codecs = codecs;
        client.headerExtensions = rtpHeaders.filter((header) =>
            [
                "urn:ietf:params:rtp-hdrext:sdes:mid",
                "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
                "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id",
                "http://tools.ietf.org/html/draft-ietf-avtext-framemarking-07",
                "urn:ietf:params:rtp-hdrext:framemarking",
                "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
                "urn:3gpp:video-orientation",
                "urn:ietf:params:rtp-hdrext:toffset",
                "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
                "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
                "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time",
                "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
            ].includes(header.uri)
        );
        const supportedCodecs: RtpCodecCapability[] = MEDIA_CODECS.map(codec => {
            const codecName = codec.mimeType.split("/")[1];
            console.log(codecName);
            const alternativePayloadType = codecName === "opus" ? 111 : 102;
            return { ...codec, preferredPayloadType: codecs.find(c => c.name.toUpperCase() === codecName.toUpperCase())?.payload_type ?? alternativePayloadType}
        })

        client.codecCapabilities = supportedCodecs;
    };

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
            client.consumers = [];
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
