// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Generate `length` cryptographically secure random bytes.
 *
 * @param length - Number of random bytes to generate.
 * @returns A `Uint8Array` of random bytes.
 */
export { randomBytes } from "@noble/hashes/utils.js";

/**
 * Convert a `Uint8Array` to its lowercase hexadecimal string representation.
 *
 * @param bytes - The bytes to encode.
 * @returns Hex string (no `0x` prefix).
 */
export { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Decode a hexadecimal string into a `Uint8Array`.
 *
 * @param hex - Hex string to decode (no `0x` prefix expected).
 * @returns The decoded bytes.
 */
export { hexToBytes } from "@noble/hashes/utils.js";

/**
 * Encode a UTF-8 string into a `Uint8Array`.
 *
 * @param str - The string to encode.
 * @returns UTF-8 encoded bytes.
 */
export { utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Concatenate multiple `Uint8Array` instances into a single `Uint8Array`.
 *
 * @param arrays - The byte arrays to concatenate.
 * @returns A new `Uint8Array` containing all input bytes in order.
 */
export { concatBytes } from "@noble/hashes/utils.js";
