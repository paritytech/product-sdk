// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
    aeadKey,
    bulletinCid,
    ChatContentCodec,
    CompactionBatchCodec,
    chatRequestDayTopic,
    chatRequestFullTopic,
    decodeChatMessage,
    ecdhDomainSecret,
    encodeChatMessage,
    filled,
    fromHex,
    HopPoolEntryCodec,
    hopAckPayload,
    hopClaimPayload,
    hopTicketKeys,
    identityProof,
    NotificationPayloadCodec,
    productAccountIndex,
    pushId,
    RequestCodec,
    ResponseCodec,
    requestChannel,
    responseChannel,
    StatementDataCodec,
    seal,
    sessionTopic,
    statementExpiry,
    toHex,
    u64le,
    x25519Agree,
    x25519PublicKey,
} from "./index.js";

const range = (start: number, end: number) =>
    Uint8Array.from({ length: end - start }, (_, index) => start + index);

describe("Appendix D vectors", () => {
    test("text statement", () => {
        const bytes = encodeChatMessage({
            id: "m1",
            timestamp: 1n,
            content: { tag: "Text", value: "hi" },
        });
        expect(toHex(bytes)).toBe("086d31010000000000000000" + "00" + "086869");
    });

    test("notification payload, Full and Stripped (Android NotificationPayloadScaleConformanceTest)", () => {
        const header = "086d31010000000000000000";
        const full = NotificationPayloadCodec.enc({
            id: "m1",
            timestamp: 1n,
            versioned: { tag: "V1", value: { tag: "Full", value: { tag: "Text", value: "hi" } } },
        });
        const stripped = NotificationPayloadCodec.enc({
            id: "m1",
            timestamp: 1n,
            versioned: {
                tag: "V1",
                value: { tag: "Stripped", value: { tag: "Text", value: "hi" } },
            },
        });
        expect(toHex(full)).toBe(`${header}0100086869`);
        expect(toHex(stripped)).toBe(`${header}0000086869`);
        const payment = NotificationPayloadCodec.enc({
            id: "m1",
            timestamp: 1n,
            versioned: {
                tag: "V1",
                value: {
                    tag: "Stripped",
                    value: { tag: "CoinagePayment", value: { totalBalance: 1_000_000_000_000n } },
                },
            },
        });
        expect(toHex(payment)).toBe(`${header}0010070010a5d4e8`);
    });

    test("compaction commit (Android CompactionScaleConformanceTest)", () => {
        const content = ChatContentCodec.enc({
            tag: "CompactionCommit",
            value: {
                claimIdentifier: range(0, 32),
                claimTicket: range(32, 64),
                node: { tag: "WssUrl", value: "wss://hop.example/node" },
            },
        });
        expect(toHex(content)).toBe(
            `1380${toHex(range(0, 32))}80${toHex(range(32, 64))}00587773733a2f2f686f702e6578616d706c652f6e6f6465`,
        );
    });

    test("compaction batch and inline envelope", () => {
        const batch = CompactionBatchCodec.enc([fromHex("aabbcc"), fromHex("0102")]);
        expect(toHex(batch)).toBe("080caabbcc080102");
        const envelope = HopPoolEntryCodec.enc({
            tag: "V1",
            value: { tag: "Inline", value: batch },
        });
        expect(toHex(envelope)).toBe("000020080caabbcc080102");
    });

    test("X25519, HKDF, ChaCha20-Poly1305", () => {
        const alice = filled(32, 0x11);
        const bob = filled(32, 0x22);
        expect(toHex(x25519PublicKey(alice))).toBe(
            "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
        );
        expect(toHex(x25519PublicKey(bob))).toBe(
            "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20",
        );
        const shared = x25519Agree(alice, x25519PublicKey(bob));
        expect(toHex(shared)).toBe(
            "9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056",
        );
        const key = aeadKey(shared);
        expect(toHex(key)).toBe("dc5774cb6f12055709d3faed4fbe6b36f192c9a610a9fa0ad748c9f89975083f");
        const sealed = seal(key, new TextEncoder().encode("hello"), range(0, 12));
        expect(toHex(sealed)).toBe(
            "000102030405060708090a0bef989ebdc534cef9b7f8d7cc5db39d153422b0831c",
        );
    });

    test("session topics, channels, push id", () => {
        const shared = fromHex("9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056");
        const a = filled(32, 0xaa);
        const b = filled(32, 0xbb);
        const topicAB = sessionTopic(shared, a, b);
        expect(toHex(topicAB)).toBe(
            "815a5e90cb4012aa75f510c809e0e494764e3457d75b68a2eca401350f944668",
        );
        expect(toHex(sessionTopic(shared, b, a))).toBe(
            "2eb6cbba7e36a54e2cd39b2229a5b7fb6731bf74e2446fd08fe0fb378cd06d73",
        );
        expect(toHex(requestChannel(topicAB))).toBe(
            "edc2f503259256b474a6a141f439e43f81f600002c1c9ac48c52b173994088e1",
        );
        expect(toHex(responseChannel(topicAB))).toBe(
            "211cd92e919681e612900384dabbf986a54168792a49c4cc5afbae905c61848a",
        );
        expect(toHex(pushId(shared, a, b))).toBe(
            "86c92e3c83d3106d992c15ab9958196fdc04b946ed0c1b103db9c2c0ee07bb47",
        );
    });

    test("request and response plaintext", () => {
        const requestId = "123e4567-e89b-12d3-a456-426614174000";
        const request = StatementDataCodec.enc({
            tag: "Request",
            value: { requestId, messages: [fromHex("dead"), fromHex("beef01")] },
        });
        expect(toHex(request)).toBe(
            "009031323365343536372d653839622d313264332d613435362d3432363631343137343030300808dead0cbeef01",
        );
        const response = StatementDataCodec.enc({
            tag: "Response",
            value: { requestId, responseCode: 0 },
        });
        expect(toHex(response)).toBe(
            "019031323365343536372d653839622d313264332d613435362d34323636313431373430303000",
        );
        // Envelope inners carry no variant byte.
        expect(
            toHex(RequestCodec.enc({ requestId, messages: [fromHex("dead"), fromHex("beef01")] })),
        ).toBe(
            "9031323365343536372d653839622d313264332d613435362d3432363631343137343030300808dead0cbeef01",
        );
        expect(ResponseCodec.enc({ requestId, responseCode: 0 }).length).toBe(38);
    });

    test("expiry", () => {
        expect(toHex(u64le(statementExpiry(1000)))).toBe("e8030000ffffffff");
    });

    test("chat key from entropy", () => {
        const secret = ecdhDomainSecret(range(0, 16), "chat");
        expect(toHex(secret)).toBe(
            "1faffb5f428d927873f89d9efe3870e25ae83e10cf39eb67a0630bfd2e63d864",
        );
        expect(toHex(x25519PublicKey(secret))).toBe(
            "3d3d3d0238844089d47cfc3b016cb1de65518078f7b9f36d683272ab3b5d791a",
        );
    });

    test("chat request topics", () => {
        const acceptor = range(0, 32);
        expect(toHex(chatRequestDayTopic(acceptor, 339))).toBe(
            "e2a94df16c50a226fff0b54f08509664d7cd0ac0add34f13114aba2eefeee13b",
        );
        expect(toHex(chatRequestFullTopic(acceptor))).toBe(
            "1c66eb7189d4dc509fd162662df8b93d1157471aec6b4dec1ff8f67bdbb8907d",
        );
    });

    test("identity proof", () => {
        const account = range(32, 64);
        expect(toHex(identityProof(filled(32, 0x42), account, account))).toBe(
            "dd26ab6d07e73634c1fe9fb538371ae3de0bcc3b193d6e370119451c622bc175",
        );
    });

    test("product account index 0", () => {
        expect(toHex(productAccountIndex(0))).toBe(
            "0000000012e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f",
        );
    });

    test("HOP ticket keys, payloads, CID", () => {
        const keys = hopTicketKeys(range(0, 32));
        expect(toHex(keys.encryptionKey)).toBe(
            "780d195b37b816da293d2296d160a8e0afcb428f8054fa22c01d3960e14c82f1",
        );
        expect(toHex(hopClaimPayload(range(0, 32)))).toBe(
            "1b17fdf115876627f63ba2d6bf1e3bfc37f3c7bda0256cd99a78e4e4187682d6",
        );
        expect(toHex(hopAckPayload(range(0, 32)))).toBe(
            "fae04ade958e93665e466e9144ad211f0e11ca1b6e80b48ba2217c27d8ccbbf7",
        );
        expect(bulletinCid(range(0, 32))).toBe(
            "bafk2bzaceaaacaqdaqcqmbyibefawdanbyhraeiscmkbkfqxdamrugy4dupb6",
        );
        expect(
            bulletinCid(
                fromHex("0bd1bb57e3f9ea801956a770fe1068f950383547aca45e1d3d354d57d014cb0c"),
            ),
        ).toBe("bafk2bzaceaf5do2x4p46vaazk2txb7qqnd4vaobvi6wkixq5hu2u2v6qctfqy");
    });
});

describe("chat message decoding", () => {
    test("unknown variant is kept as Unsupported with raw bytes", () => {
        // id "m1", ts 1, V1, content index 21 (unknown)
        const raw = fromHex("086d3101000000000000000015");
        const decoded = decodeChatMessage(raw);
        expect(decoded.kind).toBe("Unsupported");
        if (decoded.kind === "Unsupported") {
            expect(decoded.message.id).toBe("m1");
            expect(decoded.message.timestamp).toBe(1n);
            expect(toHex(decoded.message.raw)).toBe(toHex(raw));
        }
    });

    test("index 6 is unused and decodes as Unsupported", () => {
        expect(decodeChatMessage(fromHex("086d3101000000000000000006")).kind).toBe("Unsupported");
    });

    test("trailing bytes are ignored, as Android does", () => {
        const decoded = decodeChatMessage(fromHex("086d31010000000000000000000868699999"));
        expect(decoded.kind).toBe("Known");
    });

    test("iOS legacy Send decodes", () => {
        const content = ChatContentCodec.enc({
            tag: "Send",
            value: { amount: 5n, blockHash: filled(32, 1), extrinsicHash: filled(32, 2) },
        });
        expect(content[0]).toBe(2);
        expect(ChatContentCodec.dec(content).tag).toBe("Send");
    });

    test("DeviceChatAccepted uses raw 32-byte keys, DeviceAdded length-prefixed ones", () => {
        const accepted = ChatContentCodec.enc({
            tag: "DeviceChatAccepted",
            value: {
                requestId: "r",
                device: { statementAccountId: filled(32, 1), encryptionPublicKey: filled(32, 2) },
            },
        });
        expect(accepted.length).toBe(1 + 2 + 64);
        const added = ChatContentCodec.enc({
            tag: "DeviceAdded",
            value: { statementAccountId: filled(32, 1), encryptionPublicKey: filled(32, 2) },
        });
        expect(toHex(added.subarray(0, 2))).toBe("1180");
        expect(added.length).toBe(1 + 33 + 33);
    });
});
