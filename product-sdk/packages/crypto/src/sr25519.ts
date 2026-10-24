// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import * as sr25519 from "@scure/sr25519";

/**
 * sr25519 secret key (64 bytes) expanded from a 32-byte mini-secret, as Substrate expands it.
 *
 * @param seed - 32-byte mini-secret.
 * @returns The 64-byte secret key.
 */
export function sr25519SecretFromSeed(seed: Uint8Array): Uint8Array {
    return sr25519.secretFromSeed(seed);
}

/**
 * sr25519 public key of a 64-byte secret key.
 *
 * @param secretKey - 64-byte sr25519 secret key.
 * @returns The 32-byte public key.
 */
export function sr25519PublicKey(secretKey: Uint8Array): Uint8Array {
    return sr25519.getPublicKey(secretKey);
}

/**
 * sr25519 signature over `message` with the `substrate` signing context, as Substrate
 * signs and the statement store verifies.
 *
 * @param secretKey - 64-byte sr25519 secret key.
 * @param message - The bytes to sign.
 * @returns The 64-byte signature.
 */
export function sr25519Sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
    return sr25519.sign(secretKey, message);
}

/**
 * Verifies an sr25519 signature made with the `substrate` signing context.
 *
 * @param message - The signed bytes.
 * @param signature - 64-byte signature.
 * @param publicKey - 32-byte public key of the signer.
 * @returns `true` when the signature verifies; `false` otherwise, including for malformed input.
 *
 * @example
 * ```ts
 * import { randomBytes, sr25519PublicKey, sr25519SecretFromSeed, sr25519Sign, sr25519Verify } from "@parity/product-sdk-crypto";
 *
 * const secret = sr25519SecretFromSeed(randomBytes(32));
 * const signature = sr25519Sign(secret, message);
 * sr25519Verify(message, signature, sr25519PublicKey(secret)); // true
 * ```
 */
export function sr25519Verify(
    message: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
): boolean {
    try {
        return sr25519.verify(message, signature, publicKey);
    } catch {
        return false;
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    const secret = sr25519SecretFromSeed(new Uint8Array(32).fill(7));
    const message = new TextEncoder().encode("statement");

    test("a signature verifies under its public key", () => {
        const signature = sr25519Sign(secret, message);
        expect(signature.length).toBe(64);
        expect(sr25519Verify(message, signature, sr25519PublicKey(secret))).toBe(true);
    });

    test("a changed message or another key does not verify", () => {
        const signature = sr25519Sign(secret, message);
        const other = sr25519PublicKey(sr25519SecretFromSeed(new Uint8Array(32).fill(8)));
        expect(sr25519Verify(new Uint8Array([1]), signature, sr25519PublicKey(secret))).toBe(false);
        expect(sr25519Verify(message, signature, other)).toBe(false);
    });

    test("malformed input is false, not a throw", () => {
        expect(sr25519Verify(message, new Uint8Array(3), new Uint8Array(5))).toBe(false);
    });
}
