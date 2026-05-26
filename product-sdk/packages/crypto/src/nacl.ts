// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import nacl from "tweetnacl";

/**
 * Re-export of the upstream `tweetnacl` module — the primitive library that
 * backs the box helpers in this package. Reach for it directly when you need
 * raw NaCl operations the SDK doesn't wrap, such as `nacl.box.keyPair()`,
 * `nacl.randomBytes(n)`, or `nacl.sign(...)`.
 */
export { default as nacl } from "tweetnacl";

const PUBKEY_LEN = 32;
const NONCE_LEN = 24;
const SEALED_OVERHEAD = PUBKEY_LEN + NONCE_LEN;

// ---------------------------------------------------------------------------
// Sealed box — anonymous sender (ephemeral keypair)
// ---------------------------------------------------------------------------

/**
 * Sealed box encrypt: uses an ephemeral keypair so the recipient cannot identify the sender.
 *
 * Output format: `ephemeralPubKey(32) || nonce(24) || ciphertext`.
 * The ciphertext includes the 16-byte Poly1305 authentication tag.
 *
 * @param message - The plaintext bytes to encrypt.
 * @param recipientPublicKey - The recipient's 32-byte Curve25519 public key.
 * @returns A single `Uint8Array` containing the sealed message.
 * @throws If encryption fails (e.g. invalid public key).
 *
 * @example
 * ```ts
 * import { sealedBoxEncrypt, sealedBoxDecrypt } from "@parity/product-sdk-crypto";
 * import nacl from "tweetnacl";
 *
 * const recipient = nacl.box.keyPair();
 * const sealed = sealedBoxEncrypt(message, recipient.publicKey);
 * const plaintext = sealedBoxDecrypt(sealed, recipient.secretKey);
 * ```
 */
export function sealedBoxEncrypt(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(NONCE_LEN);

    const encrypted = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
    if (!encrypted) {
        throw new Error("Encryption failed");
    }

    const result = new Uint8Array(SEALED_OVERHEAD + encrypted.length);
    result.set(ephemeral.publicKey, 0);
    result.set(nonce, PUBKEY_LEN);
    result.set(encrypted, SEALED_OVERHEAD);

    return result;
}

/**
 * Sealed box decrypt: extract ephemeral public key and nonce, then open with recipient's secret key.
 *
 * Input format: `ephemeralPubKey(32) || nonce(24) || ciphertext`.
 *
 * @param sealed - The sealed message produced by {@link sealedBoxEncrypt}.
 * @param recipientSecretKey - The recipient's 32-byte Curve25519 secret key.
 * @returns The decrypted plaintext bytes.
 * @throws If the sealed data is too short, or decryption/authentication fails.
 */
export function sealedBoxDecrypt(sealed: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array {
    if (sealed.length < SEALED_OVERHEAD + nacl.box.overheadLength) {
        throw new Error("Sealed data too short");
    }

    const ephemeralPubKey = sealed.subarray(0, PUBKEY_LEN);
    const nonce = sealed.subarray(PUBKEY_LEN, SEALED_OVERHEAD);
    const ciphertext = sealed.subarray(SEALED_OVERHEAD);

    const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPubKey, recipientSecretKey);
    if (!decrypted) {
        throw new Error("Decryption failed - invalid key or corrupted data");
    }

    return decrypted;
}

// ---------------------------------------------------------------------------
// Box — identified sender (both parties known)
// ---------------------------------------------------------------------------

/**
 * NaCl box encrypt: authenticated encryption where both sender and recipient are known.
 *
 * Uses X25519 for key agreement and XSalsa20-Poly1305 for encryption.
 * Output format: `nonce(24) || ciphertext` (ciphertext includes 16-byte auth tag).
 *
 * @param message - The plaintext bytes to encrypt.
 * @param recipientPublicKey - The recipient's 32-byte Curve25519 public key.
 * @param senderSecretKey - The sender's 32-byte Curve25519 secret key.
 * @returns A single `Uint8Array` with nonce prepended to ciphertext.
 * @throws If encryption fails.
 *
 * @example
 * ```ts
 * import { boxEncrypt, boxDecrypt } from "@parity/product-sdk-crypto";
 * import nacl from "tweetnacl";
 *
 * const alice = nacl.box.keyPair();
 * const bob = nacl.box.keyPair();
 *
 * const packed = boxEncrypt(message, bob.publicKey, alice.secretKey);
 * const plaintext = boxDecrypt(packed, alice.publicKey, bob.secretKey);
 * ```
 */
export function boxEncrypt(
    message: Uint8Array,
    recipientPublicKey: Uint8Array,
    senderSecretKey: Uint8Array,
): Uint8Array {
    const nonce = nacl.randomBytes(NONCE_LEN);

    const encrypted = nacl.box(message, nonce, recipientPublicKey, senderSecretKey);
    if (!encrypted) {
        throw new Error("Encryption failed");
    }

    const result = new Uint8Array(NONCE_LEN + encrypted.length);
    result.set(nonce, 0);
    result.set(encrypted, NONCE_LEN);

    return result;
}

/**
 * NaCl box decrypt: authenticated decryption where both sender and recipient are known.
 *
 * Input format: `nonce(24) || ciphertext`.
 *
 * @param packed - The packed message produced by {@link boxEncrypt}.
 * @param senderPublicKey - The sender's 32-byte Curve25519 public key.
 * @param recipientSecretKey - The recipient's 32-byte Curve25519 secret key.
 * @returns The decrypted plaintext bytes.
 * @throws If the packed data is too short, or decryption/authentication fails.
 */
export function boxDecrypt(
    packed: Uint8Array,
    senderPublicKey: Uint8Array,
    recipientSecretKey: Uint8Array,
): Uint8Array {
    if (packed.length < NONCE_LEN + nacl.box.overheadLength) {
        throw new Error("Packed data too short");
    }

    const nonce = packed.subarray(0, NONCE_LEN);
    const ciphertext = packed.subarray(NONCE_LEN);

    const decrypted = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey);
    if (!decrypted) {
        throw new Error("Decryption failed - invalid key or corrupted data");
    }

    return decrypted;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    // Sealed box tests

    test("sealed box round-trip", () => {
        const recipient = nacl.box.keyPair();
        const message = new TextEncoder().encode("hello sealed box");
        const sealed = sealedBoxEncrypt(message, recipient.publicKey);
        const decrypted = sealedBoxDecrypt(sealed, recipient.secretKey);
        expect(new TextDecoder().decode(decrypted)).toBe("hello sealed box");
    });

    test("sealed box wrong key fails", () => {
        const recipient = nacl.box.keyPair();
        const wrongRecipient = nacl.box.keyPair();
        const message = new TextEncoder().encode("secret");
        const sealed = sealedBoxEncrypt(message, recipient.publicKey);
        expect(() => sealedBoxDecrypt(sealed, wrongRecipient.secretKey)).toThrow();
    });

    test("sealed box rejects truncated data", () => {
        expect(() => sealedBoxDecrypt(new Uint8Array(10), nacl.box.keyPair().secretKey)).toThrow(
            "Sealed data too short",
        );
    });

    test("sealed box output length matches expected format", () => {
        const recipient = nacl.box.keyPair();
        const message = new Uint8Array(42);
        const sealed = sealedBoxEncrypt(message, recipient.publicKey);
        // 32 (ephemeral pubkey) + 24 (nonce) + 42 (message) + 16 (auth tag)
        expect(sealed.length).toBe(32 + 24 + 42 + 16);
    });

    test("sealed box different recipients produce different ciphertext", () => {
        const r1 = nacl.box.keyPair();
        const r2 = nacl.box.keyPair();
        const message = new TextEncoder().encode("same message");
        const s1 = sealedBoxEncrypt(message, r1.publicKey);
        const s2 = sealedBoxEncrypt(message, r2.publicKey);
        expect(s1).not.toEqual(s2);
    });

    // Box tests (identified sender)

    test("box two-party round-trip", () => {
        const alice = nacl.box.keyPair();
        const bob = nacl.box.keyPair();
        const message = new TextEncoder().encode("hello from alice");
        const packed = boxEncrypt(message, bob.publicKey, alice.secretKey);
        const decrypted = boxDecrypt(packed, alice.publicKey, bob.secretKey);
        expect(new TextDecoder().decode(decrypted)).toBe("hello from alice");
    });

    test("box wrong sender key fails", () => {
        const alice = nacl.box.keyPair();
        const bob = nacl.box.keyPair();
        const eve = nacl.box.keyPair();
        const message = new TextEncoder().encode("secret");
        const packed = boxEncrypt(message, bob.publicKey, alice.secretKey);
        // Bob tries to decrypt but using Eve's public key as sender
        expect(() => boxDecrypt(packed, eve.publicKey, bob.secretKey)).toThrow();
    });

    test("box wrong recipient key fails", () => {
        const alice = nacl.box.keyPair();
        const bob = nacl.box.keyPair();
        const eve = nacl.box.keyPair();
        const message = new TextEncoder().encode("secret");
        const packed = boxEncrypt(message, bob.publicKey, alice.secretKey);
        // Eve tries to decrypt with her own key
        expect(() => boxDecrypt(packed, alice.publicKey, eve.secretKey)).toThrow();
    });

    test("box rejects truncated data", () => {
        const bob = nacl.box.keyPair();
        const alice = nacl.box.keyPair();
        expect(() => boxDecrypt(new Uint8Array(10), alice.publicKey, bob.secretKey)).toThrow(
            "Packed data too short",
        );
    });
}
