// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 as _sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as _bytesToHex } from "@noble/hashes/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * Compute a 32-byte BLAKE2b-256 hash.
 *
 * This is the default hash algorithm used by the Polkadot ecosystem and the
 * Bulletin Chain. Deterministic: same input always produces the same output.
 *
 * @param data - Arbitrary bytes to hash.
 * @returns 32-byte BLAKE2b-256 digest.
 *
 * @example
 * ```ts
 * import { blake2b256, bytesToHex } from "@parity/product-sdk-crypto";
 *
 * const hash = blake2b256(new TextEncoder().encode("hello"));
 * console.log(bytesToHex(hash)); // 64-char hex string
 * ```
 */
export function blake2b256(data: Uint8Array): Uint8Array {
    return blake2b(data, { dkLen: 32 });
}

/**
 * Compute a 32-byte SHA2-256 hash.
 *
 * Used by bulletin-deploy and supported by the Bulletin Chain as an
 * alternative hashing algorithm.
 *
 * @param data - Arbitrary bytes to hash.
 * @returns 32-byte SHA2-256 digest.
 *
 * @example
 * ```ts
 * import { sha256, bytesToHex } from "@parity/product-sdk-crypto";
 *
 * const hash = sha256(new TextEncoder().encode("hello"));
 * console.log(bytesToHex(hash)); // 64-char hex string
 * ```
 */
export function sha256(data: Uint8Array): Uint8Array {
    return _sha256(data);
}

/**
 * Compute a 32-byte Keccak-256 hash.
 *
 * Used for Ethereum-compatible operations (address derivation, EVM function
 * selectors) and supported by the Bulletin Chain for cross-chain compatibility.
 *
 * @param data - Arbitrary bytes to hash.
 * @returns 32-byte Keccak-256 digest.
 *
 * @example
 * ```ts
 * import { keccak256, bytesToHex } from "@parity/product-sdk-crypto";
 *
 * const hash = keccak256(new TextEncoder().encode("hello"));
 * console.log(bytesToHex(hash)); // 64-char hex string
 * ```
 */
export function keccak256(data: Uint8Array): Uint8Array {
    return keccak_256(data);
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("blake2b256", () => {
        test("produces a 32-byte hash", () => {
            const hash = blake2b256(new TextEncoder().encode("hello"));
            expect(hash).toBeInstanceOf(Uint8Array);
            expect(hash.length).toBe(32);
        });

        test("deterministic — same input, same output", () => {
            const data = new TextEncoder().encode("test");
            expect(blake2b256(data)).toEqual(blake2b256(data));
        });

        test("different inputs produce different hashes", () => {
            const a = blake2b256(new Uint8Array([1]));
            const b = blake2b256(new Uint8Array([2]));
            expect(a).not.toEqual(b);
        });

        test("empty input produces valid 32-byte hash", () => {
            const hash = blake2b256(new Uint8Array(0));
            expect(hash.length).toBe(32);
        });

        test("matches direct @noble/hashes import", () => {
            const data = new TextEncoder().encode("wrapper transparency check");
            const direct = blake2b(data, { dkLen: 32 });
            expect(blake2b256(data)).toEqual(direct);
        });
    });

    describe("sha256", () => {
        test("produces a 32-byte hash", () => {
            const hash = sha256(new TextEncoder().encode("hello"));
            expect(hash).toBeInstanceOf(Uint8Array);
            expect(hash.length).toBe(32);
        });

        test("deterministic — same input, same output", () => {
            const data = new TextEncoder().encode("test");
            expect(sha256(data)).toEqual(sha256(data));
        });

        test("different inputs produce different hashes", () => {
            const a = sha256(new Uint8Array([1]));
            const b = sha256(new Uint8Array([2]));
            expect(a).not.toEqual(b);
        });

        test("empty input produces valid 32-byte hash", () => {
            const hash = sha256(new Uint8Array(0));
            expect(hash.length).toBe(32);
        });

        test("differs from blake2b256 for same input", () => {
            const data = new TextEncoder().encode("cross-check");
            expect(sha256(data)).not.toEqual(blake2b256(data));
        });

        test("matches known SHA-256 test vector", () => {
            const hash = sha256(new TextEncoder().encode("hello"));
            expect(_bytesToHex(hash)).toBe(
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            );
        });
    });

    describe("keccak256", () => {
        test("produces a 32-byte hash", () => {
            const hash = keccak256(new TextEncoder().encode("hello"));
            expect(hash).toBeInstanceOf(Uint8Array);
            expect(hash.length).toBe(32);
        });

        test("deterministic — same input, same output", () => {
            const data = new TextEncoder().encode("test");
            expect(keccak256(data)).toEqual(keccak256(data));
        });

        test("different inputs produce different hashes", () => {
            const a = keccak256(new Uint8Array([1]));
            const b = keccak256(new Uint8Array([2]));
            expect(a).not.toEqual(b);
        });

        test("empty input produces valid 32-byte hash", () => {
            const hash = keccak256(new Uint8Array(0));
            expect(hash.length).toBe(32);
        });

        test("differs from sha256 and blake2b256 for same input", () => {
            const data = new TextEncoder().encode("cross-check");
            expect(keccak256(data)).not.toEqual(sha256(data));
            expect(keccak256(data)).not.toEqual(blake2b256(data));
        });

        test("matches known Keccak-256 test vector", () => {
            const hash = keccak256(new TextEncoder().encode("hello"));
            expect(_bytesToHex(hash)).toBe(
                "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
            );
        });
    });
}
