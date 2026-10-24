// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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

const textDecoder = new TextDecoder();

/**
 * Decode UTF-8 bytes into a string.
 *
 * @param bytes - UTF-8 encoded bytes.
 * @returns The decoded string. Invalid sequences decode to U+FFFD.
 */
export function bytesToUtf8(bytes: Uint8Array): string {
    return textDecoder.decode(bytes);
}

/**
 * Whether two byte arrays hold the same bytes.
 *
 * Not constant-time: do not use it to compare secrets or MACs.
 *
 * @param left - First byte array.
 * @param right - Second byte array.
 * @returns `true` when both have the same length and contents.
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

/**
 * Encode an unsigned 32-bit integer as 4 little-endian bytes.
 *
 * @param value - Integer in `0..2^32-1`; higher bits are dropped.
 * @returns 4 bytes, least significant first.
 */
export function u32ToLeBytes(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    return out;
}

/**
 * Encode an unsigned 64-bit integer as 8 little-endian bytes.
 *
 * @param value - Integer in `0..2^64-1`; higher bits are dropped.
 * @returns 8 bytes, least significant first.
 */
export function u64ToLeBytes(value: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
    return out;
}

/**
 * Encode a signed 64-bit integer as 8 little-endian two's-complement bytes.
 *
 * @param value - Integer in `-2^63..2^63-1`; higher bits are dropped.
 * @returns 8 bytes, least significant first.
 */
export function i64ToLeBytes(value: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, BigInt.asIntN(64, value), true);
    return out;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("bytesToUtf8 reverses utf8ToBytes", async () => {
        const { utf8ToBytes } = await import("@noble/hashes/utils.js");
        expect(bytesToUtf8(utf8ToBytes("héllo ✓"))).toBe("héllo ✓");
    });

    test("bytesEqual compares length and contents", () => {
        expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
        expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
        expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
    });

    test("little-endian integers", () => {
        expect([...u32ToLeBytes(0x01020304)]).toEqual([4, 3, 2, 1]);
        expect([...u64ToLeBytes(0xffffffff000003e8n)]).toEqual([
            0xe8, 0x03, 0, 0, 0xff, 0xff, 0xff, 0xff,
        ]);
        expect([...i64ToLeBytes(-1n)]).toEqual(Array(8).fill(0xff));
        expect([...u64ToLeBytes(-1n)]).toEqual(Array(8).fill(0xff));
    });
}
