// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
    decodeStatement,
    encodeStatement,
    filled,
    fromHex,
    requestChannel,
    type Statement,
    signedStatementSize,
    sr25519PublicKey,
    sr25519SecretFromSeed,
    sr25519Sign,
    sr25519Verify,
    statementExpiry,
    statementProofPayload,
    toHex,
} from "./index.js";

const topic = fromHex("815a5e90cb4012aa75f510c809e0e494764e3457d75b68a2eca401350f944668");

function sessionStatement(data: Uint8Array): Statement {
    return { expiry: statementExpiry(1000), channel: requestChannel(topic), topics: [topic], data };
}

describe("statement", () => {
    test("proof payload is the sorted non-proof fields without the count", () => {
        const data = filled(74, 7);
        const payload = statementProofPayload(sessionStatement(data));
        expect(toHex(payload)).toBe(
            `02e8030000ffffffff03${toHex(requestChannel(topic))}04${toHex(topic)}082901${toHex(data)}`,
        );
    });

    test("encoding puts the proof first and round-trips", () => {
        const secret = sr25519SecretFromSeed(filled(32, 9));
        const signer = sr25519PublicKey(secret);
        const statement = sessionStatement(filled(10, 1));
        const signature = sr25519Sign(secret, statementProofPayload(statement));
        const signed: Statement = {
            ...statement,
            proof: { tag: "Sr25519", value: { signature, signer } },
        };
        const bytes = encodeStatement(signed);
        expect(toHex(bytes.subarray(0, 3))).toBe("140000");
        const decoded = decodeStatement(bytes);
        expect(toHex(encodeStatement(decoded))).toBe(toHex(bytes));
        expect(sr25519Verify(statementProofPayload(decoded), signature, signer)).toBe(true);
        expect(
            sr25519Verify(
                statementProofPayload({ ...decoded, data: filled(10, 2) }),
                signature,
                signer,
            ),
        ).toBe(false);
    });

    test("size of a session statement is 175 + compact + data", () => {
        expect(signedStatementSize(sessionStatement(filled(74, 0)))).toBe(175 + 2 + 74);
    });

    test("decoding refuses out-of-order fields", () => {
        // Vec of 2 fields: Data then Expiry.
        const bytes = fromHex("08" + "0800" + "02e803000000000000");
        expect(() => decodeStatement(bytes)).toThrow();
    });

    test("more than four topics is refused", () => {
        expect(() => encodeStatement({ topics: [topic, topic, topic, topic, topic] })).toThrow();
    });
});
