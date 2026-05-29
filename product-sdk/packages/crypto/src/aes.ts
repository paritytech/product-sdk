// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";

const NONCE_LENGTH = 12;
const AES_KEY_LENGTH = 32;

function validateKey(key: Uint8Array): void {
    if (key.length !== AES_KEY_LENGTH) {
        throw new Error(`AES-256-GCM requires a 32-byte key, got ${key.length}`);
    }
}

/**
 * Encrypt binary data with AES-256-GCM.
 *
 * Generates a random 12-byte nonce and returns it alongside the ciphertext.
 * The ciphertext includes the 16-byte authentication tag appended by GCM.
 *
 * @param data - Binary data to encrypt.
 * @param key - 32-byte AES-256 key.
 * @returns Object containing the `ciphertext` and the random `nonce` used.
 * @throws If `key` is not exactly 32 bytes.
 *
 * @example
 * ```ts
 * import { aesGcmEncrypt, aesGcmDecrypt } from "@parity/product-sdk-crypto";
 * import { randomBytes } from "@parity/product-sdk-crypto";
 *
 * const key = randomBytes(32);
 * const { ciphertext, nonce } = aesGcmEncrypt(data, key);
 * const plaintext = aesGcmDecrypt(ciphertext, key, nonce);
 * ```
 */
export function aesGcmEncrypt(
    data: Uint8Array,
    key: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    validateKey(key);
    const nonce = randomBytes(NONCE_LENGTH);
    const aes = gcm(key, nonce);
    const ciphertext = aes.encrypt(data);
    return { ciphertext, nonce };
}

/**
 * Decrypt binary data with AES-256-GCM.
 *
 * @param ciphertext - Data to decrypt (includes the 16-byte GCM auth tag).
 * @param key - 32-byte AES-256 key (must match the encryption key).
 * @param nonce - 12-byte nonce used during encryption.
 * @returns The decrypted plaintext as a `Uint8Array`.
 * @throws If `key` is not 32 bytes, or if decryption/authentication fails.
 */
export function aesGcmDecrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
): Uint8Array {
    validateKey(key);
    const aes = gcm(key, nonce);
    return aes.decrypt(ciphertext);
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 *
 * Convenience wrapper that encodes the string to bytes before encrypting.
 *
 * @param plaintext - The string to encrypt.
 * @param key - 32-byte AES-256 key.
 * @returns Object containing the `ciphertext` and the random `nonce` used.
 * @throws If `key` is not exactly 32 bytes.
 */
export function aesGcmEncryptText(
    plaintext: string,
    key: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    return aesGcmEncrypt(new TextEncoder().encode(plaintext), key);
}

/**
 * Decrypt AES-256-GCM ciphertext back to a UTF-8 string.
 *
 * @param ciphertext - Data to decrypt.
 * @param key - 32-byte AES-256 key.
 * @param nonce - 12-byte nonce used during encryption.
 * @returns The decrypted plaintext string.
 * @throws If decryption or authentication fails.
 */
export function aesGcmDecryptText(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
): string {
    const data = aesGcmDecrypt(ciphertext, key, nonce);
    return new TextDecoder().decode(data);
}

/**
 * Encrypt binary data with AES-256-GCM, returning a single packed buffer.
 *
 * Output format: `nonce(12) || ciphertext`. This is the convention used by
 * the triangle-js-sdks session encryption and mark3t file encryption.
 *
 * @param data - Binary data to encrypt.
 * @param key - 32-byte AES-256 key.
 * @returns Single `Uint8Array` with nonce prepended to ciphertext.
 * @throws If `key` is not exactly 32 bytes.
 *
 * @example
 * ```ts
 * const packed = aesGcmEncryptPacked(data, key);
 * const plaintext = aesGcmDecryptPacked(packed, key);
 * ```
 */
export function aesGcmEncryptPacked(data: Uint8Array, key: Uint8Array): Uint8Array {
    const { ciphertext, nonce } = aesGcmEncrypt(data, key);
    const result = new Uint8Array(NONCE_LENGTH + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, NONCE_LENGTH);
    return result;
}

/**
 * Decrypt a packed AES-256-GCM buffer (nonce prepended to ciphertext).
 *
 * Input format: `nonce(12) || ciphertext`.
 *
 * @param packed - The packed buffer to decrypt.
 * @param key - 32-byte AES-256 key.
 * @returns The decrypted plaintext as a `Uint8Array`.
 * @throws If `key` is not 32 bytes, the packed data is too short, or authentication fails.
 */
export function aesGcmDecryptPacked(packed: Uint8Array, key: Uint8Array): Uint8Array {
    if (packed.length < NONCE_LENGTH + 16) {
        throw new Error("Packed data too short");
    }
    const nonce = packed.subarray(0, NONCE_LENGTH);
    const ciphertext = packed.subarray(NONCE_LENGTH);
    return aesGcmDecrypt(ciphertext, key, nonce);
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("text round-trip", () => {
        const key = randomBytes(32);
        const message = "hello world";
        const { ciphertext, nonce } = aesGcmEncryptText(message, key);
        const decrypted = aesGcmDecryptText(ciphertext, key, nonce);
        expect(decrypted).toBe(message);
    });

    test("binary round-trip", () => {
        const key = randomBytes(32);
        const data = randomBytes(64);
        const { ciphertext, nonce } = aesGcmEncrypt(data, key);
        const decrypted = aesGcmDecrypt(ciphertext, key, nonce);
        expect(decrypted).toEqual(data);
    });

    test("wrong key fails", () => {
        const key = randomBytes(32);
        const wrongKey = randomBytes(32);
        const { ciphertext, nonce } = aesGcmEncryptText("secret", key);
        expect(() => aesGcmDecryptText(ciphertext, wrongKey, nonce)).toThrow();
    });

    test("rejects non-32-byte key", () => {
        expect(() => aesGcmEncryptText("test", randomBytes(16))).toThrow("32-byte key");
        expect(() => aesGcmEncryptText("test", randomBytes(64))).toThrow("32-byte key");
    });

    test("unique nonces per encryption", () => {
        const key = randomBytes(32);
        const a = aesGcmEncryptText("test", key);
        const b = aesGcmEncryptText("test", key);
        expect(a.nonce).not.toEqual(b.nonce);
    });

    test("packed binary round-trip", () => {
        const key = randomBytes(32);
        const data = randomBytes(100);
        const packed = aesGcmEncryptPacked(data, key);
        const decrypted = aesGcmDecryptPacked(packed, key);
        expect(decrypted).toEqual(data);
    });

    test("packed output length is nonce + ciphertext", () => {
        const key = randomBytes(32);
        const data = randomBytes(50);
        const packed = aesGcmEncryptPacked(data, key);
        // GCM adds a 16-byte auth tag
        expect(packed.length).toBe(12 + 50 + 16);
    });

    test("packed rejects truncated data", () => {
        expect(() => aesGcmDecryptPacked(new Uint8Array(10), randomBytes(32))).toThrow(
            "Packed data too short",
        );
    });
}
