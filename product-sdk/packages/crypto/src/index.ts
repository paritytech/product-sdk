// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-crypto — Cryptographic primitives for the Polkadot app ecosystem.
 *
 * Provides symmetric encryption (AES-256-GCM, ChaCha20-Poly1305, XChaCha20-Poly1305),
 * key derivation (HKDF-SHA256), asymmetric encryption (NaCl box / sealed box),
 * X25519 key agreement, sr25519 signatures, hashing (BLAKE2b, keyed BLAKE2b, SHA-256,
 * Keccak-256), and cryptographic random bytes.
 * All functions are synchronous and framework-agnostic.
 *
 * Each module is also a subpath (`@parity/product-sdk-crypto/x25519`, `/sr25519`,
 * `/chacha`, `/hashing`, `/hkdf`, `/aes`, `/encoding`, `/nacl`). A worker imports
 * from the subpaths: this barrel reaches tweetnacl, whose Node `require("crypto")`
 * a worker bundle cannot resolve.
 *
 * @packageDocumentation
 */
export * from "./aes.js";
export * from "./chacha.js";
export * from "./hkdf.js";
export * from "./nacl.js";
export * from "./encoding.js";
export * from "./hashing.js";
export * from "./types.js";
export * from "./x25519.js";
export * from "./sr25519.js";
