// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { Vector } from "scale-ts";
import { PeerConnectionSignalCodec } from "../wire/call.js";
import type { ChatContent } from "../wire/chatMessage.js";
import { CALL_PURPOSE } from "../wire/chatMessage.js";
import { decodeStrict } from "../wire/scale.js";
import {
    type CallSetup,
    decodeCandidates,
    decodeSetup,
    encodeCandidates,
    encodeSetup,
    type IceCandidate,
} from "./sdp.js";

/** The signals of one send of the host's call engine: SCALE `Vec<PeerConnectionSignal>`, as iOS encodes them. */
export const PeerSignalsCodec = Vector(PeerConnectionSignalCodec);

/** One signal of the host's call engine. */
export type PeerSignal = ReturnType<typeof PeerConnectionSignalCodec.dec>;

/** Candidates a setup message carries before the rest go in their own messages (iOS batcher). */
const SETUP_CANDIDATES_MAX = 6;
/** Candidates one `DataChannelIceCandidate` carries. */
const CANDIDATES_PER_MESSAGE = 12;

type Batch =
    | { kind: "Offer"; setup: CallSetup }
    | { kind: "Answer"; setup: CallSetup }
    | { kind: "Candidates"; candidates: IceCandidate[] }
    | { kind: "Closed" };

function candidatesOf(signal: Extract<PeerSignal, { tag: "IceCandidates" }>): IceCandidate[] {
    return signal.value.map(({ sdp, sdpMLineIndex, sdpMid }) => ({
        sdp,
        sdpMLineIndex,
        ...(sdpMid !== undefined ? { sdpMid } : {}),
    }));
}

/** Groups signals into the messages the native chat sends: a setup takes up to 6 candidates, the rest go 12 a message. */
function batch(signals: PeerSignal[]): Batch[] {
    const batches: Batch[] = [];
    for (const signal of signals) {
        switch (signal.tag) {
            case "Offer":
            case "Answer":
                batches.push({ kind: signal.tag, setup: { sdp: signal.value, candidates: [] } });
                break;
            case "Closed":
                batches.push({ kind: "Closed" });
                break;
            case "IceCandidates": {
                const remaining = candidatesOf(signal);
                const last = batches[batches.length - 1];
                if (last && (last.kind === "Offer" || last.kind === "Answer")) {
                    const room = SETUP_CANDIDATES_MAX - last.setup.candidates.length;
                    last.setup.candidates.push(...remaining.splice(0, Math.max(0, room)));
                } else if (last?.kind === "Candidates") {
                    const room = CANDIDATES_PER_MESSAGE - last.candidates.length;
                    last.candidates.push(...remaining.splice(0, Math.max(0, room)));
                }
                while (remaining.length > 0)
                    batches.push({
                        kind: "Candidates",
                        candidates: remaining.splice(0, CANDIDATES_PER_MESSAGE),
                    });
                break;
            }
        }
    }
    return batches;
}

/** A call message to send, and whether it is the offer, whose message id is the call id. */
export interface CallMessage {
    content: ChatContent;
    offer: boolean;
}

function callMessageOf(
    item: Batch,
    call: { offerId: string; video: boolean },
    nowMs: number,
): CallMessage {
    switch (item.kind) {
        case "Offer":
            return {
                offer: true,
                content: {
                    tag: "DataChannelOffer",
                    value: {
                        sdp: encodeSetup(item.setup, nowMs),
                        purpose: call.video ? CALL_PURPOSE.Video : CALL_PURPOSE.Audio,
                    },
                },
            };
        case "Answer":
            return {
                offer: false,
                content: {
                    tag: "DataChannelAnswer",
                    value: { offerMessageId: call.offerId, sdp: encodeSetup(item.setup, nowMs) },
                },
            };
        case "Candidates":
            return {
                offer: false,
                content: {
                    tag: "DataChannelIceCandidate",
                    value: { offerMessageId: call.offerId, sdp: encodeCandidates(item.candidates) },
                },
            };
        case "Closed":
            return {
                offer: false,
                content: { tag: "DataChannelClosed", value: { offerMessageId: call.offerId } },
            };
    }
}

/**
 * The native call messages (A.16) of a send of the host's call engine. `offerId` names the call in every message after
 * the offer; `video` is the purpose of an offer.
 */
export function callMessagesOf(
    signal: Uint8Array,
    call: { offerId: string; video: boolean },
    nowMs: number,
): CallMessage[] {
    return batch(decodeStrict(PeerSignalsCodec, signal)).map((item) =>
        callMessageOf(item, call, nowMs),
    );
}

function setupSignals(kind: "Offer" | "Answer", setup: CallSetup): PeerSignal[] {
    const candidates: PeerSignal = {
        tag: "IceCandidates",
        value: setup.candidates.map(({ sdp, sdpMLineIndex, sdpMid }) => ({
            sdp,
            sdpMLineIndex,
            sdpMid,
        })),
    };
    return setup.candidates.length > 0
        ? [{ tag: kind, value: setup.sdp }, candidates]
        : [{ tag: kind, value: setup.sdp }];
}

/** The host signal of a native call message, for `callMedia.signal`, or undefined for any other content. */
export function hostSignalOf(content: ChatContent): Uint8Array | undefined {
    switch (content.tag) {
        case "DataChannelOffer":
            return PeerSignalsCodec.enc(setupSignals("Offer", decodeSetup(content.value.sdp)));
        case "DataChannelAnswer":
            return PeerSignalsCodec.enc(setupSignals("Answer", decodeSetup(content.value.sdp)));
        case "DataChannelIceCandidate":
            return PeerSignalsCodec.enc([
                {
                    tag: "IceCandidates",
                    value: decodeCandidates(content.value.sdp).map(
                        ({ sdp, sdpMLineIndex, sdpMid }) => ({
                            sdp,
                            sdpMLineIndex,
                            sdpMid,
                        }),
                    ),
                },
            ]);
        case "DataChannelClosed":
            return PeerSignalsCodec.enc([{ tag: "Closed", value: undefined }]);
        default:
            return undefined;
    }
}
