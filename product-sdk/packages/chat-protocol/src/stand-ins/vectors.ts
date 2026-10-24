// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The chat-spec Appendix D vectors, as data.
 *
 * Each vector names its inputs and the bytes the protocol must produce from them,
 * so another implementation (an app, a port to another language) can check
 * itself against the same values; `checkVectors()` checks this one.
 *
 * @module
 */
import { filled, fromHex, toHex, u64le, utf8 } from "../bytes.js";
import {
    bulletinCid,
    chatRequestDayTopic,
    chatRequestFullTopic,
    ecdhDomainSecret,
    hopAckPayload,
    hopClaimPayload,
    hopTicketKeys,
    identityProof,
    productAccountIndex,
    pushId,
    requestChannel,
    responseChannel,
    sessionTopic,
    statementExpiry,
} from "../crypto/derivations.js";
import { aeadKey, seal, x25519Agree, x25519PublicKey } from "../crypto/primitives.js";
import { encodeChatMessage } from "../wire/chatMessage.js";
import { CompactionBatchCodec, HopPoolEntryCodec } from "../wire/hop.js";
import { NotificationPayloadCodec } from "../wire/notification.js";
import { StatementDataCodec } from "../wire/statementData.js";

/** One vector: what goes in, and the hex the protocol must produce. */
export interface ProtocolVector {
    name: string;
    /** The inputs, as the spec states them. */
    inputs: string;
    /** Lowercase hex without `0x` (or the CID text for a CID). */
    expected: string;
    /** What this implementation produces. */
    compute(): string;
}

const range = (start: number, end: number) =>
    Uint8Array.from({ length: end - start }, (_, index) => start + index);
const ALICE = filled(32, 0x11);
const BOB = filled(32, 0x22);
const SHARED = "9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056";
const REQUEST_ID = "123e4567-e89b-12d3-a456-426614174000";

/** The vectors. */
export const PROTOCOL_VECTORS: readonly ProtocolVector[] = [
    {
        name: "text message",
        inputs: 'ChatMessageStatement { id: "m1", timestamp: 1, V1 Text "hi" }',
        expected: "086d3101000000000000000000086869",
        compute: () =>
            toHex(
                encodeChatMessage({
                    id: "m1",
                    timestamp: 1n,
                    content: { tag: "Text", value: "hi" },
                }),
            ),
    },
    {
        name: "notification payload, Full",
        inputs: 'id "m1", timestamp 1, V1 Full Text "hi"',
        expected: "086d310100000000000000000100086869",
        compute: () =>
            toHex(
                NotificationPayloadCodec.enc({
                    id: "m1",
                    timestamp: 1n,
                    versioned: {
                        tag: "V1",
                        value: { tag: "Full", value: { tag: "Text", value: "hi" } },
                    },
                }),
            ),
    },
    {
        name: "compaction batch in an inline entry",
        inputs: "batch [aabbcc, 0102], VersionedUploadedFile V1 Inline",
        expected: "000020080caabbcc080102",
        compute: () =>
            toHex(
                HopPoolEntryCodec.enc({
                    tag: "V1",
                    value: {
                        tag: "Inline",
                        value: CompactionBatchCodec.enc([fromHex("aabbcc"), fromHex("0102")]),
                    },
                }),
            ),
    },
    {
        name: "X25519 public key",
        inputs: "private key 32 x 0x11",
        expected: "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
        compute: () => toHex(x25519PublicKey(ALICE)),
    },
    {
        name: "X25519 agreement",
        inputs: "private 32 x 0x11, public of 32 x 0x22",
        expected: SHARED,
        compute: () => toHex(x25519Agree(ALICE, x25519PublicKey(BOB))),
    },
    {
        name: "session AEAD key",
        inputs: "HKDF-SHA256 of the agreement, empty salt and info, 32 bytes",
        expected: "dc5774cb6f12055709d3faed4fbe6b36f192c9a610a9fa0ad748c9f89975083f",
        compute: () => toHex(aeadKey(fromHex(SHARED))),
    },
    {
        name: "sealed blob",
        inputs: 'the session key, nonce 00..0b, plaintext "hello"',
        expected: "000102030405060708090a0bef989ebdc534cef9b7f8d7cc5db39d153422b0831c",
        compute: () => toHex(seal(aeadKey(fromHex(SHARED)), utf8("hello"), range(0, 12))),
    },
    {
        name: "session topic A to B",
        inputs: "the agreement, A = 32 x 0xaa, B = 32 x 0xbb",
        expected: "815a5e90cb4012aa75f510c809e0e494764e3457d75b68a2eca401350f944668",
        compute: () => toHex(sessionTopic(fromHex(SHARED), filled(32, 0xaa), filled(32, 0xbb))),
    },
    {
        name: "request channel",
        inputs: "of the session topic A to B",
        expected: "edc2f503259256b474a6a141f439e43f81f600002c1c9ac48c52b173994088e1",
        compute: () =>
            toHex(
                requestChannel(sessionTopic(fromHex(SHARED), filled(32, 0xaa), filled(32, 0xbb))),
            ),
    },
    {
        name: "response channel",
        inputs: "of the session topic A to B",
        expected: "211cd92e919681e612900384dabbf986a54168792a49c4cc5afbae905c61848a",
        compute: () =>
            toHex(
                responseChannel(sessionTopic(fromHex(SHARED), filled(32, 0xaa), filled(32, 0xbb))),
            ),
    },
    {
        name: "push id",
        inputs: "the agreement, A to B",
        expected: "86c92e3c83d3106d992c15ab9958196fdc04b946ed0c1b103db9c2c0ee07bb47",
        compute: () => toHex(pushId(fromHex(SHARED), filled(32, 0xaa), filled(32, 0xbb))),
    },
    {
        name: "request frame",
        inputs: `Request { requestId: "${REQUEST_ID}", messages: [dead, beef01] }`,
        expected:
            "009031323365343536372d653839622d313264332d613435362d3432363631343137343030300808dead0cbeef01",
        compute: () =>
            toHex(
                StatementDataCodec.enc({
                    tag: "Request",
                    value: {
                        requestId: REQUEST_ID,
                        messages: [fromHex("dead"), fromHex("beef01")],
                    },
                }),
            ),
    },
    {
        name: "expiry of priority 1000",
        inputs: "high half all ones, low half the priority, little-endian u64",
        expected: "e8030000ffffffff",
        compute: () => toHex(u64le(statementExpiry(1000))),
    },
    {
        name: "chat key from entropy",
        inputs: 'RFC-0022 ECDH domain "chat", entropy 00..0f',
        expected: "1faffb5f428d927873f89d9efe3870e25ae83e10cf39eb67a0630bfd2e63d864",
        compute: () => toHex(ecdhDomainSecret(range(0, 16), "chat")),
    },
    {
        name: "chat-request day topic",
        inputs: "acceptor 00..1f, day 339",
        expected: "e2a94df16c50a226fff0b54f08509664d7cd0ac0add34f13114aba2eefeee13b",
        compute: () => toHex(chatRequestDayTopic(range(0, 32), 339)),
    },
    {
        name: "chat-request full topic",
        inputs: "acceptor 00..1f",
        expected: "1c66eb7189d4dc509fd162662df8b93d1157471aec6b4dec1ff8f67bdbb8907d",
        compute: () => toHex(chatRequestFullTopic(range(0, 32))),
    },
    {
        name: "identity proof",
        inputs: "shared 32 x 0x42, identity and statement account 20..3f",
        expected: "dd26ab6d07e73634c1fe9fb538371ae3de0bcc3b193d6e370119451c622bc175",
        compute: () => toHex(identityProof(filled(32, 0x42), range(32, 64), range(32, 64))),
    },
    {
        name: "product account index 0",
        inputs: "RFC-0022",
        expected: "0000000012e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f",
        compute: () => toHex(productAccountIndex(0)),
    },
    {
        name: "HOP ticket encryption key",
        inputs: "ticket 00..1f",
        expected: "780d195b37b816da293d2296d160a8e0afcb428f8054fa22c01d3960e14c82f1",
        compute: () => toHex(hopTicketKeys(range(0, 32)).encryptionKey),
    },
    {
        name: "HOP claim payload",
        inputs: "hash 00..1f",
        expected: "1b17fdf115876627f63ba2d6bf1e3bfc37f3c7bda0256cd99a78e4e4187682d6",
        compute: () => toHex(hopClaimPayload(range(0, 32))),
    },
    {
        name: "HOP ack payload",
        inputs: "hash 00..1f",
        expected: "fae04ade958e93665e466e9144ad211f0e11ca1b6e80b48ba2217c27d8ccbbf7",
        compute: () => toHex(hopAckPayload(range(0, 32))),
    },
    {
        name: "Bulletin CID",
        inputs: "BLAKE2b-256 hash 00..1f",
        expected: "bafk2bzaceaaacaqdaqcqmbyibefawdanbyhraeiscmkbkfqxdamrugy4dupb6",
        compute: () => bulletinCid(range(0, 32)),
    },
];

/** The vectors this implementation gets wrong; empty when it conforms. */
export function checkVectors(): { name: string; expected: string; actual: string }[] {
    return PROTOCOL_VECTORS.flatMap((vector) => {
        const actual = vector.compute();
        return actual === vector.expected
            ? []
            : [{ name: vector.name, expected: vector.expected, actual }];
    });
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("this implementation conforms to every vector", () => {
        expect(checkVectors()).toEqual([]);
        expect(PROTOCOL_VECTORS.length).toBeGreaterThan(20);
    });
}
