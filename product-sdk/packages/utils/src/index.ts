// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-utils — Encoding, hashing, token formatting, and balance querying for the Polkadot app ecosystem.
 *
 * Provides general-purpose byte encoding/decoding (`bytesToHex`, `hexToBytes`, `utf8ToBytes`,
 * `concatBytes`), 32-byte hash functions (`blake2b256`, `sha256`, `keccak256`),
 * Substrate token formatting (`formatPlanck`, `parseToPlanck`, `formatBalance`),
 * and typed balance queries (`getBalance`).
 * All functions are framework-agnostic.
 *
 * @packageDocumentation
 */
export * from "./encoding.js";
export * from "./hashing.js";
export * from "./planck.js";
export * from "./balance.js";
