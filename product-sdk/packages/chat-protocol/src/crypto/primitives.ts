// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { chachaDecryptPacked, chachaEncryptPacked } from "@parity/product-sdk-crypto/chacha";
import { deriveKey } from "@parity/product-sdk-crypto/hkdf";

export { randomBytes } from "@parity/product-sdk-crypto/encoding";
export { blake2b256, sha256 as sha256Hash } from "@parity/product-sdk-crypto/hashing";
export {
    sr25519PublicKey,
    sr25519SecretFromSeed,
    sr25519Sign,
    sr25519Verify,
} from "@parity/product-sdk-crypto/sr25519";
export {
    x25519Keypair,
    x25519PublicKey,
    x25519SharedSecret as x25519Agree,
} from "@parity/product-sdk-crypto/x25519";

/** Length of the ChaCha20-Poly1305 nonce prefixed to every sealed blob. */
export const NONCE_LENGTH = 12;

/** Bytes `seal` adds: nonce and tag. */
export const SEAL_OVERHEAD = NONCE_LENGTH + 16;

const EMPTY = new Uint8Array(0);

/** HKDF-SHA256 of a shared secret with empty salt and info: the session AEAD key. */
export function aeadKey(sharedSecret: Uint8Array): Uint8Array {
    return deriveKey(sharedSecret, EMPTY, EMPTY);
}

/** `nonce ‖ ChaCha20-Poly1305(key, nonce, plaintext)`, no associated data. */
export function seal(key: Uint8Array, plaintext: Uint8Array, nonce?: Uint8Array): Uint8Array {
    return chachaEncryptPacked(plaintext, key, nonce);
}

/** Opens a `seal` blob. Throws on a wrong key or tampered data. */
export function open(key: Uint8Array, sealed: Uint8Array): Uint8Array {
    return chachaDecryptPacked(sealed, key);
}
