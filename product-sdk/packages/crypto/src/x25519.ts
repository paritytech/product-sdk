// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";

/**
 * X25519 public key of a 32-byte private key.
 *
 * @param privateKey - 32-byte X25519 private key.
 * @returns The 32-byte public key.
 */
export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
    return x25519.getPublicKey(privateKey);
}

/**
 * A fresh random X25519 keypair.
 *
 * @returns The 32-byte `privateKey` and its 32-byte `publicKey`.
 */
export function x25519Keypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const privateKey = randomBytes(32);
    return { privateKey, publicKey: x25519PublicKey(privateKey) };
}

/**
 * Raw X25519 agreement between a private key and a peer's public key.
 *
 * The all-zero result, which a low-order peer key produces, is refused: such a secret
 * carries no entropy and would make every derived key public.
 *
 * @param privateKey - Our 32-byte private key.
 * @param publicKey - The peer's 32-byte public key.
 * @returns The 32-byte shared secret. Hash or HKDF it before use as a key.
 * @throws If the agreement produces the all-zero secret, or a key is malformed.
 *
 * @example
 * ```ts
 * import { x25519Keypair, x25519SharedSecret } from "@parity/product-sdk-crypto";
 *
 * const alice = x25519Keypair();
 * const bob = x25519Keypair();
 * x25519SharedSecret(alice.privateKey, bob.publicKey); // equals the other way round
 * ```
 */
export function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    const shared = x25519.getSharedSecret(privateKey, publicKey);
    if (shared.every((byte) => byte === 0)) {
        throw new Error("X25519 agreement produced the all-zero secret");
    }
    return shared;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { bytesToHex } = await import("@noble/hashes/utils.js");

    test("matches the chat-spec Appendix D vectors", () => {
        const alice = new Uint8Array(32).fill(0x11);
        const bob = new Uint8Array(32).fill(0x22);
        expect(bytesToHex(x25519PublicKey(alice))).toBe(
            "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
        );
        expect(bytesToHex(x25519PublicKey(bob))).toBe(
            "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20",
        );
        expect(bytesToHex(x25519SharedSecret(alice, x25519PublicKey(bob)))).toBe(
            "9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056",
        );
    });

    test("agreement is symmetric", () => {
        const alice = x25519Keypair();
        const bob = x25519Keypair();
        expect(x25519SharedSecret(alice.privateKey, bob.publicKey)).toEqual(
            x25519SharedSecret(bob.privateKey, alice.publicKey),
        );
    });

    test("refuses a low-order public key", () => {
        expect(() => x25519SharedSecret(x25519Keypair().privateKey, new Uint8Array(32))).toThrow();
    });
}
