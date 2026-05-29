// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { getPublicKey, secretFromSeed } from "@scure/sr25519";
import { describe, expect, it } from "vitest";
import { createChainCode, deriveProductAccountPublicKey } from "./product-account.js";

describe("createChainCode", () => {
    it("encodes the numeric junction '0' as 32 zero bytes (u64 LE, zero-padded)", () => {
        const result = createChainCode("0");
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.length).toBe(32);
        expect(Array.from(result)).toEqual(new Array(32).fill(0));
    });

    it("encodes the numeric junction '1' as [1, 0×31] (u64 LE, zero-padded)", () => {
        const result = createChainCode("1");
        const expected = new Uint8Array(32);
        expected[0] = 1;
        expect(Array.from(result)).toEqual(Array.from(expected));
    });

    it("encodes a string junction 'product' as SCALE str + zero-padded to 32 bytes", () => {
        const result = createChainCode("product");
        expect(result.length).toBe(32);
        expect(result[0]).toBe(0x1c); // compact-length: 7 << 2
        expect(new TextDecoder().decode(result.slice(1, 8))).toBe("product");
        expect(Array.from(result.slice(8))).toEqual(new Array(24).fill(0));
    });

    it("encodes a string junction near the 32-byte boundary without falling back to blake2b", () => {
        const code = "a".repeat(30);
        const result = createChainCode(code);
        expect(result.length).toBe(32);
        expect(result[0]).toBe(30 << 2);
        expect(new TextDecoder().decode(result.slice(1, 31))).toBe(code);
        expect(result[31]).toBe(0);
    });

    it("hashes a string junction whose SCALE encoding exceeds 32 bytes via blake2b256", () => {
        // The encoded form of "a".repeat(100) is compact-length(100) + 100 utf8 bytes
        // = 2 + 100 = 102 bytes, which exceeds the 32-byte slot and triggers the
        // blake2b fallback. The expected hex value below is the blake2b-256 hash
        // of the SCALE-encoded bytes; locking it pins us to a specific hash function.
        const longCode = "a".repeat(100);
        const result = createChainCode(longCode);
        expect(result.length).toBe(32);
        const hex = `0x${Array.from(result)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")}`;
        // Compute this once locally and paste below. To regenerate after a deliberate
        // algorithm change, run the assertion, copy the actual hex from the failure
        // diff, and update.
        expect(hex).toBe("0x0cc6ae1565611349f15a291549fc38c30273d4bf600eec3ec6dfffff6d5bb8d8");
    });
});

// ---------------------------------------------------------------------------
// Helpers shared by the frozen-vector block below
// ---------------------------------------------------------------------------

function pubKeyFromSeedByte(byte: number): Uint8Array {
    const seed = new Uint8Array(32).fill(byte);
    const secretKey = secretFromSeed(seed);
    return getPublicKey(secretKey);
}

function toHex(bytes: Uint8Array): string {
    return `0x${Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
}

describe("deriveProductAccountPublicKey (frozen vectors)", () => {
    it("playground.dot / index 0, parent pubkey from seed byte 0x00", () => {
        const root = pubKeyFromSeedByte(0);
        const result = deriveProductAccountPublicKey(root, "playground.dot", 0);
        expect(toHex(result)).toBe(
            "0xc2beceb2dd5d6011d03647374c6f21fbab1132d2b7bc872de4edf249952fb525",
        );
    });

    it("playground.dot / index 1, parent pubkey from seed byte 0x01 (non-zero u64 branch)", () => {
        const root = pubKeyFromSeedByte(1);
        const result = deriveProductAccountPublicKey(root, "playground.dot", 1);
        expect(toHex(result)).toBe(
            "0x886a3a296d26b4971e066631f5a1dbb7ad7db61468e1bd9429353ff93afac622",
        );
    });

    it("near-boundary productId, parent pubkey from seed byte 0x02 (no blake2b fallback)", () => {
        const root = pubKeyFromSeedByte(2);
        const result = deriveProductAccountPublicKey(root, "a-very-long-product.dot", 0);
        expect(toHex(result)).toBe(
            "0xa04c8edbb5c77fd8bd934a1d0c60b7d9d2eeed870ac7d35a94a10a91451d8f04",
        );
    });

    it("long productId triggers blake2b fallback for the second junction, parent from seed byte 0x03", () => {
        const root = pubKeyFromSeedByte(3);
        const result = deriveProductAccountPublicKey(
            root,
            "this-name-is-deliberately-long-enough-to-trip-the-fallback.dot",
            0,
        );
        expect(toHex(result)).toBe(
            "0x5cbabd54efcc45d1d4c1dc8b87b02ffd2ba5e70584ac005e7bd3484810054605",
        );
    });
});
