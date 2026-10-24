// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { str } from "scale-ts";

import { concat, i64le, u32le, u64le, utf8 } from "../bytes.js";
import { VecU8 } from "../wire/scale.js";
import { blake2b256, sr25519PublicKey, sr25519SecretFromSeed } from "./primitives.js";

/** Start of protocol time: 2025-11-15T00:00:00Z, in unix seconds. */
export const PROTOCOL_EPOCH = 1763164800;

const EXPIRY_HIGH = 0xffffffffn << 32n;

/** Seconds since the protocol epoch, floored at 0, as a statement priority. */
export function statementPriority(nowMs: number): number {
    return Math.max(0, Math.floor(nowMs / 1000) - PROTOCOL_EPOCH) >>> 0;
}

/** Statement expiry for a priority: never expires by time, the low half orders replacements. */
export function statementExpiry(priority: number): bigint {
    return EXPIRY_HIGH | BigInt(priority >>> 0);
}

/** The next expiry of a session counter: strictly above `previous`, and at least the current priority. */
export function nextExpiry(previous: bigint, nowMs: number): bigint {
    const current = statementExpiry(statementPriority(nowMs));
    return previous + 1n > current ? previous + 1n : current;
}

/** Day number since the protocol epoch, for chat-request day topics. */
export function protocolDay(nowMs: number): number {
    return Math.max(0, Math.floor((Math.floor(nowMs / 1000) - PROTOCOL_EPOCH) / 86400));
}

const SLASH = utf8("/");

/** `A ‖ B ‖ "/" ‖ pinA ‖ "/" ‖ pinB` (pins are empty in every current flow). */
export function sessionParams(
    first: Uint8Array,
    second: Uint8Array,
    firstPin = "",
    secondPin = "",
): Uint8Array {
    return concat(first, second, SLASH, utf8(firstPin), SLASH, utf8(secondPin));
}

/** Session topic from `sender` to `receiver`, keyed with the raw X25519 shared secret. */
export function sessionTopic(
    sharedSecret: Uint8Array,
    sender: Uint8Array,
    receiver: Uint8Array,
): Uint8Array {
    return blake2b256(concat(utf8("session"), sessionParams(sender, receiver)), sharedSecret);
}

/** Request channel of a topic. */
export function requestChannel(topic: Uint8Array): Uint8Array {
    return blake2b256(utf8("request"), topic);
}

/** Response channel of a topic. */
export function responseChannel(topic: Uint8Array): Uint8Array {
    return blake2b256(utf8("response"), topic);
}

/** Push id from `sender` to `receiver`, keyed with the identity-session shared secret. */
export function pushId(
    identitySharedSecret: Uint8Array,
    sender: Uint8Array,
    receiver: Uint8Array,
): Uint8Array {
    return blake2b256(
        concat(utf8("notification"), sessionParams(sender, receiver)),
        identitySharedSecret,
    );
}

const CHAT_REQUEST = str.enc("chat-request");

/** Chat-request topic holding every request to `acceptor`. */
export function chatRequestFullTopic(acceptor: Uint8Array): Uint8Array {
    return blake2b256(concat(CHAT_REQUEST, VecU8.enc(acceptor)));
}

/** Chat-request topic for requests to `acceptor` published on protocol day `day`. */
export function chatRequestDayTopic(acceptor: Uint8Array, day: number): Uint8Array {
    return blake2b256(concat(CHAT_REQUEST, VecU8.enc(acceptor), u64le(BigInt(day))));
}

/** Per-pair chat-request topic, keyed with the X25519 secret of the two chat identity keys. */
export function chatRequestSessionTopic(
    chatSharedSecret: Uint8Array,
    requester: Uint8Array,
    acceptor: Uint8Array,
): Uint8Array {
    return blake2b256(
        concat(utf8("chat-request"), sessionParams(requester, acceptor)),
        chatSharedSecret,
    );
}

/** V2 identity proof: binds a statement account to an identity under the chat-key shared secret. */
export function identityProof(
    chatSharedSecret: Uint8Array,
    identityAccount: Uint8Array,
    statementAccount: Uint8Array,
): Uint8Array {
    return blake2b256(
        concat(identityAccount, statementAccount, str.enc("mds-chat-request")),
        chatSharedSecret,
    );
}

/** Chain code of a hard junction named by a string: its SCALE encoding, zero-padded to 32 bytes or hashed if longer. */
export function stringChainCode(name: string): Uint8Array {
    const encoded = str.enc(name);
    if (encoded.length > 32) return blake2b256(encoded);
    const out = new Uint8Array(32);
    out.set(encoded);
    return out;
}

/** RFC-0022 ECDH key material for `domain` (`chat`, `sso`): `B(key=chaincode(domain), B(key="ecdh", entropy))`. */
export function ecdhDomainSecret(entropy: Uint8Array, domain: string): Uint8Array {
    return blake2b256(blake2b256(entropy, utf8("ecdh")), stringChainCode(domain));
}

/** RFC-0022 product account index: `u32le(n) ‖ B("product-account-index")[0..28]`. */
export function productAccountIndex(index: number): Uint8Array {
    return concat(u32le(index), blake2b256(utf8("product-account-index")).subarray(0, 28));
}

/** Keys of a HOP ticket: the file AEAD key and the claim/ack sr25519 key. */
export function hopTicketKeys(ticket: Uint8Array): {
    encryptionKey: Uint8Array;
    signerSecret: Uint8Array;
    signerPublic: Uint8Array;
} {
    const encryptionKey = blake2b256(utf8("encryption"), ticket);
    const signerSecret = sr25519SecretFromSeed(blake2b256(utf8("signer"), ticket));
    return { encryptionKey, signerSecret, signerPublic: sr25519PublicKey(signerSecret) };
}

/** What `hop_submit` signs. */
export function hopSubmitPayload(entry: Uint8Array, submitTimestampMs: bigint): Uint8Array {
    return blake2b256(concat(utf8("hop-submit-v1:"), blake2b256(entry), i64le(submitTimestampMs)));
}

/** What `hop_claim` signs. */
export function hopClaimPayload(hash: Uint8Array): Uint8Array {
    return blake2b256(concat(utf8("hop-claim-v1:"), hash));
}

/** What `hop_ack` signs. */
export function hopAckPayload(hash: Uint8Array): Uint8Array {
    return blake2b256(concat(utf8("hop-ack-v1:"), hash));
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32LowerNoPad(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

/** CIDv1 (raw codec, BLAKE2b-256 multihash) of a BLAKE2b-256 hash, as Bulletin bitswap and TrUAPI preimage lookup use. */
export function bulletinCid(hash: Uint8Array): string {
    return `b${base32LowerNoPad(concat(new Uint8Array([0x01, 0x55, 0xa0, 0xe4, 0x02, 0x20]), hash))}`;
}
