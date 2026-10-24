// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { bytesEqual } from "../bytes.js";
import { sessionTopic } from "../crypto/derivations.js";
import { aeadKey, open, randomBytes, seal, x25519Agree } from "../crypto/primitives.js";
import { decodeStrict } from "../wire/scale.js";
import type { Statement } from "../wire/statement.js";
import { RequestCodec, ResponseCodec, StatementDataCodec } from "../wire/statementData.js";
import type { IncomingRequest, OutgoingRequest, ResponseRecord } from "./sessionState.js";

/** A frame to send on a lane. */
export type OutgoingFrame =
    | { kind: "Request"; request: OutgoingRequest }
    | { kind: "Response"; response: ResponseRecord };

/** A frame read from a statement. */
export type IncomingFrame =
    | { kind: "Request"; request: IncomingRequest }
    | { kind: "Response"; response: ResponseRecord };

/** A device of a contact, as its roster holds it. */
export interface PeerDevice {
    statementAccountId: Uint8Array;
    encryptionPublicKey: Uint8Array;
}

/**
 * One direction pair of a contact session: where we write, where we read,
 * and how frames are sealed (Appendix A.6, A.7).
 */
export interface SessionLane {
    readonly outgoingTopic: Uint8Array;
    /** Topics the peer writes on. May change when the peer's device roster changes. */
    incomingTopics(): Uint8Array[];
    /** Statement data for `frame`. */
    encode(frame: OutgoingFrame): Uint8Array;
    /** Reads a peer statement, or undefined when it is not for this lane or is refused. */
    decodePeer(statement: Statement, signer: Uint8Array): IncomingFrame | undefined;
    /** Reads one of our own statements on the outgoing topic. */
    decodeOwn(statement: Statement): IncomingFrame | undefined;
}

function frameFromData(
    data:
        | { tag: "Request"; value: { requestId: string; messages: Uint8Array[] } }
        | { tag: "Response"; value: { requestId: string; responseCode: number } },
    expiry: bigint,
): IncomingFrame {
    return data.tag === "Request"
        ? {
              kind: "Request",
              request: { requestId: data.value.requestId, messages: data.value.messages, expiry },
          }
        : {
              kind: "Response",
              response: {
                  requestId: data.value.requestId,
                  responseCode: data.value.responseCode,
                  expiry,
              },
          };
}

function plainData(frame: OutgoingFrame): Uint8Array {
    return frame.kind === "Request"
        ? StatementDataCodec.enc({
              tag: "Request",
              value: { requestId: frame.request.requestId, messages: frame.request.messages },
          })
        : StatementDataCodec.enc({
              tag: "Response",
              value: {
                  requestId: frame.response.requestId,
                  responseCode: frame.response.responseCode,
              },
          });
}

function topicMatches(statement: Statement, topic: Uint8Array): boolean {
    const first = statement.topics[0];
    return first !== undefined && bytesEqual(first, topic);
}

/** Parameters of a pairwise (identity) lane. */
export interface PairwiseLaneParams {
    /** Our identity account. */
    localAccount: Uint8Array;
    /** The peer's identity account. */
    remoteAccount: Uint8Array;
    /** Our identity chat X25519 secret. */
    chatSecret: Uint8Array;
    /** The peer's identity chat X25519 public key. */
    peerChatKey: Uint8Array;
    /** Signers accepted besides the peer's identity account: its roster statement accounts. */
    extraSigners?: () => Uint8Array[];
    /** Called when a statement on our topic comes from an unexpected signer (kept, D10). */
    onUnexpectedSigner?: (signer: Uint8Array) => void;
}

/** Pairwise lane: both sides use their identity chat keys and accounts. Also the identity lane of a multi-device session. */
export class PairwiseLane implements SessionLane {
    readonly outgoingTopic: Uint8Array;
    private readonly incomingTopic: Uint8Array;
    private readonly key: Uint8Array;

    constructor(private readonly params: PairwiseLaneParams) {
        const shared = x25519Agree(params.chatSecret, params.peerChatKey);
        this.key = aeadKey(shared);
        this.outgoingTopic = sessionTopic(shared, params.localAccount, params.remoteAccount);
        this.incomingTopic = sessionTopic(shared, params.remoteAccount, params.localAccount);
    }

    incomingTopics(): Uint8Array[] {
        return [this.incomingTopic];
    }

    encode(frame: OutgoingFrame): Uint8Array {
        return seal(this.key, plainData(frame));
    }

    decodePeer(statement: Statement, signer: Uint8Array): IncomingFrame | undefined {
        if (!topicMatches(statement, this.incomingTopic) || !statement.data) return undefined;
        const known =
            bytesEqual(signer, this.params.remoteAccount) ||
            (this.params.extraSigners?.() ?? []).some((account) => bytesEqual(account, signer));
        if (!known) this.params.onUnexpectedSigner?.(signer);
        return this.decodeData(statement.data, statement.expiry ?? 0n);
    }

    decodeOwn(statement: Statement): IncomingFrame | undefined {
        if (!topicMatches(statement, this.outgoingTopic) || !statement.data) return undefined;
        return this.decodeData(statement.data, statement.expiry ?? 0n);
    }

    private decodeData(data: Uint8Array, expiry: bigint): IncomingFrame | undefined {
        try {
            const decoded = decodeStrict(StatementDataCodec, open(this.key, data));
            if (decoded.tag === "Request" || decoded.tag === "Response")
                return frameFromData(decoded, expiry);
            return undefined;
        } catch {
            return undefined;
        }
    }
}

/** Parameters of a multi-device (main) lane. */
export interface MultiDeviceLaneParams {
    /** Our statement account: the signer of our statements and the key of our envelope entries. */
    statementAccount: Uint8Array;
    /** Our identity account. */
    identityAccount: Uint8Array;
    /** The peer's identity account. */
    remoteAccount: Uint8Array;
    /** Our identity chat X25519 secret. */
    chatSecret: Uint8Array;
    /** Our device X25519 secret. */
    deviceSecret: Uint8Array;
    /** The peer's identity chat X25519 public key. */
    peerChatKey: Uint8Array;
    /** The peer's devices, read at each use. */
    roster: () => PeerDevice[];
}

/**
 * Multi-device lane: we write once per sender device with a random payload key
 * wrapped for each peer device, and read one topic per peer device.
 */
export class MultiDeviceLane implements SessionLane {
    readonly outgoingTopic: Uint8Array;
    private readonly outerKey: Uint8Array;

    constructor(private readonly params: MultiDeviceLaneParams) {
        const shared = x25519Agree(params.deviceSecret, params.peerChatKey);
        this.outerKey = aeadKey(shared);
        this.outgoingTopic = sessionTopic(shared, params.statementAccount, params.remoteAccount);
    }

    private deviceTopic(device: PeerDevice): { topic: Uint8Array; key: Uint8Array } {
        const shared = x25519Agree(this.params.chatSecret, device.encryptionPublicKey);
        return {
            topic: sessionTopic(shared, device.statementAccountId, this.params.identityAccount),
            key: aeadKey(shared),
        };
    }

    incomingTopics(): Uint8Array[] {
        return this.params.roster().map((device) => this.deviceTopic(device).topic);
    }

    encode(frame: OutgoingFrame): Uint8Array {
        const devices = this.params.roster();
        if (devices.length === 0) throw new Error("multi-device lane without peer devices");
        const inner =
            frame.kind === "Request"
                ? RequestCodec.enc({
                      requestId: frame.request.requestId,
                      messages: frame.request.messages,
                  })
                : ResponseCodec.enc({
                      requestId: frame.response.requestId,
                      responseCode: frame.response.responseCode,
                  });
        const payloadKey = randomBytes(32);
        const payload = seal(payloadKey, inner);
        const devicesInfo = devices.map((device) => ({
            statementAccountId: device.statementAccountId,
            encryptedKey: seal(
                aeadKey(x25519Agree(this.params.deviceSecret, device.encryptionPublicKey)),
                payloadKey,
            ),
        }));
        const data =
            frame.kind === "Request"
                ? StatementDataCodec.enc({
                      tag: "MultiRequest",
                      value: { encryptedRequest: payload, devicesInfo },
                  })
                : StatementDataCodec.enc({
                      tag: "MultiResponse",
                      value: { encryptedResponse: payload, devicesInfo },
                  });
        return seal(this.outerKey, data);
    }

    decodePeer(statement: Statement, signer: Uint8Array): IncomingFrame | undefined {
        if (!statement.data) return undefined;
        for (const device of this.params.roster()) {
            const { topic, key } = this.deviceTopic(device);
            if (!topicMatches(statement, topic)) continue;
            // Device lane: only the device's own statement account may write on its topic (D10).
            if (!bytesEqual(signer, device.statementAccountId)) return undefined;
            return this.decode(statement.data, key, statement.expiry ?? 0n, (devicesInfo) => {
                const entry = devicesInfo.find((info) =>
                    bytesEqual(info.statementAccountId, this.params.statementAccount),
                );
                return (
                    entry && {
                        encryptedKey: entry.encryptedKey,
                        senderKey: device.encryptionPublicKey,
                    }
                );
            });
        }
        return undefined;
    }

    decodeOwn(statement: Statement): IncomingFrame | undefined {
        if (!topicMatches(statement, this.outgoingTopic) || !statement.data) return undefined;
        const devices = this.params.roster();
        return this.decode(statement.data, this.outerKey, statement.expiry ?? 0n, (devicesInfo) => {
            for (const info of devicesInfo) {
                const device = devices.find((candidate) =>
                    bytesEqual(candidate.statementAccountId, info.statementAccountId),
                );
                if (device)
                    return {
                        encryptedKey: info.encryptedKey,
                        senderKey: device.encryptionPublicKey,
                    };
            }
            return undefined;
        });
    }

    private decode(
        data: Uint8Array,
        outerKey: Uint8Array,
        expiry: bigint,
        pickEntry: (
            devicesInfo: { statementAccountId: Uint8Array; encryptedKey: Uint8Array }[],
        ) => { encryptedKey: Uint8Array; senderKey: Uint8Array } | undefined,
    ): IncomingFrame | undefined {
        try {
            const decoded = decodeStrict(StatementDataCodec, open(outerKey, data));
            if (decoded.tag === "Request" || decoded.tag === "Response")
                return frameFromData(decoded, expiry);
            const entry = pickEntry(decoded.value.devicesInfo);
            if (!entry) return undefined;
            const payloadKey = open(
                aeadKey(x25519Agree(this.params.deviceSecret, entry.senderKey)),
                entry.encryptedKey,
            );
            if (decoded.tag === "MultiRequest") {
                const inner = decodeStrict(
                    RequestCodec,
                    open(payloadKey, decoded.value.encryptedRequest),
                );
                return {
                    kind: "Request",
                    request: { requestId: inner.requestId, messages: inner.messages, expiry },
                };
            }
            const inner = decodeStrict(
                ResponseCodec,
                open(payloadKey, decoded.value.encryptedResponse),
            );
            return {
                kind: "Response",
                response: { requestId: inner.requestId, responseCode: inner.responseCode, expiry },
            };
        } catch {
            return undefined;
        }
    }
}
