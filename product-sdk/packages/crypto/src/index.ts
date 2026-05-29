// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-crypto — Cryptographic primitives for the Polkadot app ecosystem.
 *
 * Provides symmetric encryption (AES-256-GCM, ChaCha20-Poly1305, XChaCha20-Poly1305),
 * key derivation (HKDF-SHA256), asymmetric encryption (NaCl box / sealed box),
 * hashing (BLAKE2b-256, SHA-256, Keccak-256), and cryptographic random bytes.
 * All functions are synchronous and framework-agnostic.
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
