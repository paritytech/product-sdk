// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { chacha20poly1305, xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";

const KEY_LENGTH = 32;
const CHACHA_NONCE_LENGTH = 12;
const XCHACHA_NONCE_LENGTH = 24;

function validateKey(key: Uint8Array): void {
    if (key.length !== KEY_LENGTH) {
        throw new Error(`ChaCha20-Poly1305 requires a 32-byte key, got ${key.length}`);
    }
}

// ---------------------------------------------------------------------------
// ChaCha20-Poly1305 (12-byte nonce, RFC 8439)
// ---------------------------------------------------------------------------

/**
 * Encrypt binary data with ChaCha20-Poly1305 (RFC 8439).
 *
 * Uses a random 12-byte nonce. Callers must ensure a given key is not reused
 * for more than ~2^32 encryptions to avoid nonce collision. For high-volume
 * random-nonce use cases, prefer {@link xchachaEncrypt} (24-byte nonce).
 *
 * @param data - Binary data to encrypt.
 * @param key - 32-byte encryption key.
 * @returns Object containing the `ciphertext` (with 16-byte Poly1305 tag appended) and `nonce`.
 * @throws If `key` is not exactly 32 bytes.
 *
 * @example
 * ```ts
 * import { chachaEncrypt, chachaDecrypt, randomBytes } from "@parity/product-sdk-crypto";
 *
 * const key = randomBytes(32);
 * const { ciphertext, nonce } = chachaEncrypt(data, key);
 * const plaintext = chachaDecrypt(ciphertext, key, nonce);
 * ```
 */
export function chachaEncrypt(
    data: Uint8Array,
    key: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    validateKey(key);
    const nonce = randomBytes(CHACHA_NONCE_LENGTH);
    const cipher = chacha20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(data);
    return { ciphertext, nonce };
}

/**
 * Decrypt binary data with ChaCha20-Poly1305 (RFC 8439).
 *
 * @param ciphertext - Data to decrypt (includes 16-byte Poly1305 tag).
 * @param key - 32-byte encryption key.
 * @param nonce - 12-byte nonce used during encryption.
 * @returns The decrypted plaintext.
 * @throws If `key` is not 32 bytes, or if decryption/authentication fails.
 */
export function chachaDecrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
): Uint8Array {
    validateKey(key);
    const cipher = chacha20poly1305(key, nonce);
    return cipher.decrypt(ciphertext);
}

/**
 * Encrypt a UTF-8 string with ChaCha20-Poly1305.
 *
 * @param plaintext - The string to encrypt.
 * @param key - 32-byte encryption key.
 * @returns Object containing `ciphertext` and `nonce`.
 * @throws If `key` is not exactly 32 bytes.
 */
export function chachaEncryptText(
    plaintext: string,
    key: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    return chachaEncrypt(new TextEncoder().encode(plaintext), key);
}

/**
 * Decrypt ChaCha20-Poly1305 ciphertext back to a UTF-8 string.
 *
 * @param ciphertext - Data to decrypt.
 * @param key - 32-byte encryption key.
 * @param nonce - 12-byte nonce used during encryption.
 * @returns The decrypted plaintext string.
 * @throws If decryption or authentication fails.
 */
export function chachaDecryptText(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
): string {
    return new TextDecoder().decode(chachaDecrypt(ciphertext, key, nonce));
}

// ---------------------------------------------------------------------------
// XChaCha20-Poly1305 (24-byte nonce — preferred for random nonces)
// ---------------------------------------------------------------------------

/**
 * Encrypt binary data with XChaCha20-Poly1305.
 *
 * The 24-byte nonce makes random nonce generation safe for virtually unlimited
 * encryptions under the same key (~2^96 nonce space vs 2^48 for 12-byte).
 * This is the **recommended** symmetric cipher for most use cases.
 *
 * @param data - Binary data to encrypt.
 * @param key - 32-byte encryption key.
 * @returns Object containing `ciphertext` (with 16-byte tag) and 24-byte `nonce`.
 * @throws If `key` is not exactly 32 bytes.
 *
 * @example
 * ```ts
 * import { xchachaEncrypt, xchachaDecrypt, randomBytes } from "@parity/product-sdk-crypto";
 *
 * const key = randomBytes(32);
 * const { ciphertext, nonce } = xchachaEncrypt(data, key);
 * const plaintext = xchachaDecrypt(ciphertext, key, nonce);
 * ```
 */
export function xchachaEncrypt(
    data: Uint8Array,
    key: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    validateKey(key);
    const nonce = randomBytes(XCHACHA_NONCE_LENGTH);
    const cipher = xchacha20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(data);
    return { ciphertext, nonce };
}

/**
 * Decrypt binary data with XChaCha20-Poly1305.
 *
 * @param ciphertext - Data to decrypt (includes 16-byte Poly1305 tag).
 * @param key - 32-byte encryption key.
 * @param nonce - 24-byte nonce used during encryption.
 * @returns The decrypted plaintext.
 * @throws If `key` is not 32 bytes, or if decryption/authentication fails.
 */
export function xchachaDecrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
): Uint8Array {
    validateKey(key);
    const cipher = xchacha20poly1305(key, nonce);
    return cipher.decrypt(ciphertext);
}

/**
 * Encrypt a UTF-8 string with XChaCha20-Poly1305.
 *
 * @param plaintext - The string to encrypt.
 * @param key - 32-byte encryption key.
 * @returns Object containing `ciphertext` and 24-byte `nonce`.
 * @throws If `key` is not exactly 32 bytes.
 */
export function xchachaEncryptText(
    plaintext: string,
    key: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    return xchachaEncrypt(new TextEncoder().encode(plaintext), key);
}

/**
 * Decrypt XChaCha20-Poly1305 ciphertext back to a UTF-8 string.
 *
 * @param ciphertext - Data to decrypt.
 * @param key - 32-byte encryption key.
 * @param nonce - 24-byte nonce used during encryption.
 * @returns The decrypted plaintext string.
 * @throws If decryption or authentication fails.
 */
export function xchachaDecryptText(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
): string {
    return new TextDecoder().decode(xchachaDecrypt(ciphertext, key, nonce));
}

/**
 * Encrypt binary data with XChaCha20-Poly1305, returning a single packed buffer.
 *
 * Output format: `nonce(24) || ciphertext`. Convenient for storage or transmission
 * where a single blob is preferred.
 *
 * @param data - Binary data to encrypt.
 * @param key - 32-byte encryption key.
 * @returns Single `Uint8Array` with nonce prepended to ciphertext.
 * @throws If `key` is not exactly 32 bytes.
 *
 * @example
 * ```ts
 * const packed = xchachaEncryptPacked(data, key);
 * const plaintext = xchachaDecryptPacked(packed, key);
 * ```
 */
export function xchachaEncryptPacked(data: Uint8Array, key: Uint8Array): Uint8Array {
    const { ciphertext, nonce } = xchachaEncrypt(data, key);
    const result = new Uint8Array(XCHACHA_NONCE_LENGTH + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, XCHACHA_NONCE_LENGTH);
    return result;
}

/**
 * Decrypt a packed XChaCha20-Poly1305 buffer (nonce prepended to ciphertext).
 *
 * Input format: `nonce(24) || ciphertext`.
 *
 * @param packed - The packed buffer to decrypt.
 * @param key - 32-byte encryption key.
 * @returns The decrypted plaintext.
 * @throws If the packed data is too short, key is invalid, or authentication fails.
 */
export function xchachaDecryptPacked(packed: Uint8Array, key: Uint8Array): Uint8Array {
    if (packed.length < XCHACHA_NONCE_LENGTH + 16) {
        throw new Error("Packed data too short");
    }
    const nonce = packed.subarray(0, XCHACHA_NONCE_LENGTH);
    const ciphertext = packed.subarray(XCHACHA_NONCE_LENGTH);
    return xchachaDecrypt(ciphertext, key, nonce);
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    // ChaCha20-Poly1305

    test("chacha binary round-trip", () => {
        const key = randomBytes(32);
        const data = randomBytes(64);
        const { ciphertext, nonce } = chachaEncrypt(data, key);
        const decrypted = chachaDecrypt(ciphertext, key, nonce);
        expect(decrypted).toEqual(data);
    });

    test("chacha text round-trip", () => {
        const key = randomBytes(32);
        const { ciphertext, nonce } = chachaEncryptText("hello chacha", key);
        expect(chachaDecryptText(ciphertext, key, nonce)).toBe("hello chacha");
    });

    test("chacha wrong key fails", () => {
        const key = randomBytes(32);
        const { ciphertext, nonce } = chachaEncryptText("secret", key);
        expect(() => chachaDecryptText(ciphertext, randomBytes(32), nonce)).toThrow();
    });

    test("chacha rejects non-32-byte key", () => {
        expect(() => chachaEncrypt(randomBytes(10), randomBytes(16))).toThrow("32-byte key");
    });

    // XChaCha20-Poly1305

    test("xchacha binary round-trip", () => {
        const key = randomBytes(32);
        const data = randomBytes(128);
        const { ciphertext, nonce } = xchachaEncrypt(data, key);
        expect(nonce.length).toBe(24);
        const decrypted = xchachaDecrypt(ciphertext, key, nonce);
        expect(decrypted).toEqual(data);
    });

    test("xchacha text round-trip", () => {
        const key = randomBytes(32);
        const { ciphertext, nonce } = xchachaEncryptText("hello xchacha", key);
        expect(xchachaDecryptText(ciphertext, key, nonce)).toBe("hello xchacha");
    });

    test("xchacha packed round-trip", () => {
        const key = randomBytes(32);
        const data = randomBytes(50);
        const packed = xchachaEncryptPacked(data, key);
        // 24-byte nonce + 50-byte data + 16-byte tag
        expect(packed.length).toBe(24 + 50 + 16);
        const decrypted = xchachaDecryptPacked(packed, key);
        expect(decrypted).toEqual(data);
    });

    test("xchacha packed rejects truncated data", () => {
        expect(() => xchachaDecryptPacked(new Uint8Array(10), randomBytes(32))).toThrow(
            "Packed data too short",
        );
    });

    test("unique nonces per encryption", () => {
        const key = randomBytes(32);
        const a = xchachaEncrypt(randomBytes(10), key);
        const b = xchachaEncrypt(randomBytes(10), key);
        expect(a.nonce).not.toEqual(b.nonce);
    });
}
