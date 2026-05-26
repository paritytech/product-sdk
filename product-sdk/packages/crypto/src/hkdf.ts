// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Re-export the full HKDF function from `@noble/hashes` for advanced use cases
 * that need custom hash functions or output lengths.
 */
export { hkdf, extract, expand } from "@noble/hashes/hkdf.js";

/**
 * Derive a 32-byte key using HKDF-SHA256 (RFC 5869).
 *
 * This is a convenience wrapper around the full HKDF function, fixed to SHA-256
 * and a 32-byte output length — suitable for deriving symmetric encryption keys.
 *
 * @param ikm - Input keying material (e.g. a shared secret or master key).
 * @param salt - Salt value (string or bytes). Use a unique, application-specific salt.
 * @param info - Context/application-specific info string (string or bytes).
 * @returns A 32-byte derived key as `Uint8Array`.
 *
 * @example
 * ```ts
 * import { deriveKey, randomBytes } from "@parity/product-sdk-crypto";
 *
 * const masterKey = randomBytes(32);
 * const encryptionKey = deriveKey(masterKey, "myapp-v1", "document-encryption");
 * ```
 */
export function deriveKey(
    ikm: Uint8Array,
    salt: Uint8Array | string,
    info: Uint8Array | string,
): Uint8Array {
    const saltBytes = typeof salt === "string" ? new TextEncoder().encode(salt) : salt;
    const infoBytes = typeof info === "string" ? new TextEncoder().encode(info) : info;
    return hkdf(sha256, ikm, saltBytes, infoBytes, 32);
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { randomBytes } = await import("@noble/hashes/utils.js");

    test("deriveKey is deterministic with 32-byte output", () => {
        const ikm = new Uint8Array(32).fill(0xab);
        const a = deriveKey(ikm, "salt", "info");
        const b = deriveKey(ikm, "salt", "info");
        expect(a).toEqual(b);
        expect(a.length).toBe(32);
    });

    test("deriveKey accepts string and Uint8Array params", () => {
        const ikm = new Uint8Array(32).fill(0xcd);
        const saltBytes = new TextEncoder().encode("salt");
        const infoBytes = new TextEncoder().encode("info");
        const fromStrings = deriveKey(ikm, "salt", "info");
        const fromBytes = deriveKey(ikm, saltBytes, infoBytes);
        expect(fromStrings).toEqual(fromBytes);
    });

    test("different salts produce different keys", () => {
        const ikm = randomBytes(32);
        const a = deriveKey(ikm, "salt-a", "info");
        const b = deriveKey(ikm, "salt-b", "info");
        expect(a).not.toEqual(b);
    });

    test("different info strings produce different keys", () => {
        const ikm = randomBytes(32);
        const a = deriveKey(ikm, "salt", "encryption");
        const b = deriveKey(ikm, "salt", "signing");
        expect(a).not.toEqual(b);
    });

    test("RFC 5869 test vector (case 1)", () => {
        // https://www.rfc-editor.org/rfc/rfc5869#appendix-A - Test Case 1
        const ikm = new Uint8Array(22).fill(0x0b);
        const salt = new Uint8Array([
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
        ]);
        const info = new Uint8Array([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
        const expected = new Uint8Array([
            0x3c, 0xb2, 0x5f, 0x25, 0xfa, 0xac, 0xd5, 0x7a, 0x90, 0x43, 0x4f, 0x64, 0xd0, 0x36,
            0x2f, 0x2a, 0x2d, 0x2d, 0x0a, 0x90, 0xcf, 0x1a, 0x5a, 0x4c, 0x5d, 0xb0, 0x2d, 0x56,
            0xec, 0xc4, 0xc5, 0xbf,
        ]);
        // The RFC vector OKM is 42 bytes; deriveKey returns 32, so compare the first 32 bytes
        const result = deriveKey(ikm, salt, info);
        expect(result).toEqual(expected);
    });
}
