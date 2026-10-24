// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { concat } from "../bytes.js";

const MASK = (1n << 64n) - 1n;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;

function rotl(value: bigint, bits: bigint): bigint {
    return ((value << bits) | (value >> (64n - bits))) & MASK;
}

function readU64(bytes: Uint8Array, offset: number): bigint {
    let value = 0n;
    for (let index = 7; index >= 0; index--)
        value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
    return value;
}

function readU32(bytes: Uint8Array, offset: number): bigint {
    let value = 0n;
    for (let index = 3; index >= 0; index--)
        value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
    return value;
}

function round(accumulator: bigint, lane: bigint): bigint {
    return (rotl((accumulator + lane * PRIME2) & MASK, 31n) * PRIME1) & MASK;
}

function mergeRound(accumulator: bigint, value: bigint): bigint {
    return ((((accumulator ^ round(0n, value)) * PRIME1) & MASK) + PRIME4) & MASK;
}

/** xxHash64 of `bytes` with `seed`. */
export function xxhash64(bytes: Uint8Array, seed: bigint): bigint {
    const length = bytes.length;
    let offset = 0;
    let hash: bigint;
    if (length >= 32) {
        let v1 = (seed + PRIME1 + PRIME2) & MASK;
        let v2 = (seed + PRIME2) & MASK;
        let v3 = seed & MASK;
        let v4 = (seed - PRIME1) & MASK;
        while (offset + 32 <= length) {
            v1 = round(v1, readU64(bytes, offset));
            v2 = round(v2, readU64(bytes, offset + 8));
            v3 = round(v3, readU64(bytes, offset + 16));
            v4 = round(v4, readU64(bytes, offset + 24));
            offset += 32;
        }
        hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
        hash = mergeRound(hash, v1);
        hash = mergeRound(hash, v2);
        hash = mergeRound(hash, v3);
        hash = mergeRound(hash, v4);
    } else {
        hash = (seed + PRIME5) & MASK;
    }
    hash = (hash + BigInt(length)) & MASK;
    while (offset + 8 <= length) {
        hash ^= round(0n, readU64(bytes, offset));
        hash = (rotl(hash, 27n) * PRIME1 + PRIME4) & MASK;
        offset += 8;
    }
    if (offset + 4 <= length) {
        hash ^= (readU32(bytes, offset) * PRIME1) & MASK;
        hash = (rotl(hash, 23n) * PRIME2 + PRIME3) & MASK;
        offset += 4;
    }
    while (offset < length) {
        hash ^= (BigInt(bytes[offset] ?? 0) * PRIME5) & MASK;
        hash = (rotl(hash, 11n) * PRIME1) & MASK;
        offset += 1;
    }
    hash ^= hash >> 33n;
    hash = (hash * PRIME2) & MASK;
    hash ^= hash >> 29n;
    hash = (hash * PRIME3) & MASK;
    hash ^= hash >> 32n;
    return hash;
}

function u64Bytes(value: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    return out;
}

/** Substrate `twox_128`: xxHash64 with seeds 0 and 1, little-endian. */
export function twox128(bytes: Uint8Array): Uint8Array {
    return concat(u64Bytes(xxhash64(bytes, 0n)), u64Bytes(xxhash64(bytes, 1n)));
}
