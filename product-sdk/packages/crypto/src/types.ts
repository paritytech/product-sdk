// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Symmetric cipher algorithm identifiers supported by this package.
 *
 * - `"aes-256-gcm"` — AES-256 in Galois/Counter Mode (128-bit tag).
 * - `"chacha20-poly1305"` — ChaCha20 with Poly1305 MAC (RFC 8439, 12-byte nonce).
 * - `"xchacha20-poly1305"` — Extended-nonce ChaCha20 with Poly1305 (24-byte nonce).
 *   Preferred for random nonce generation due to negligible collision probability.
 */
export type SymmetricAlgorithm = "aes-256-gcm" | "chacha20-poly1305" | "xchacha20-poly1305";

/**
 * Key encapsulation mechanism identifiers.
 *
 * Classical:
 * - `"x25519"` — Curve25519 Diffie-Hellman key agreement.
 *
 * Post-quantum (future, not yet implemented):
 * - `"ml-kem-768"` — Module-Lattice Key Encapsulation (FIPS 203), ~AES-192 equivalent security.
 * - `"x25519-ml-kem-768"` — Hybrid classical + post-quantum for defense-in-depth.
 *
 * PQC types are defined for forward compatibility. Implementations will be added
 * when audited libraries (e.g. `@noble/post-quantum`) reach stable releases.
 */
export type KemAlgorithm = "x25519" | "ml-kem-768" | "x25519-ml-kem-768";

/**
 * Common encrypted payload envelope carrying algorithm metadata alongside ciphertext.
 * Useful for protocols that need to negotiate or identify the cipher used.
 */
export interface EncryptedPayload {
    /** The symmetric algorithm used to produce this ciphertext. */
    algorithm: SymmetricAlgorithm;
    /** The encrypted data (does not include the nonce). */
    ciphertext: Uint8Array;
    /** The nonce/IV used during encryption. */
    nonce: Uint8Array;
    /** How the symmetric key was established (omit if key was pre-shared or derived directly via HKDF). */
    kem?: KemAlgorithm;
}
