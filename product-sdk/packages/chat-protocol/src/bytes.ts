// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { bytesToHex, bytesToUtf8, concatBytes, utf8ToBytes } from "@parity/product-sdk-utils";

export {
    bytesEqual,
    i64ToLeBytes as i64le,
    u32ToLeBytes as u32le,
    u64ToLeBytes as u64le,
} from "@parity/product-sdk-utils";

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array {
    return utf8ToBytes(text);
}

/** Text of UTF-8 `bytes`. */
export function fromUtf8(bytes: Uint8Array): string {
    return bytesToUtf8(bytes);
}

/** Concatenation of `parts`. */
export function concat(...parts: Uint8Array[]): Uint8Array {
    return concatBytes(...parts);
}

/** Lowercase hex of `bytes`, without a `0x` prefix. */
export function toHex(bytes: Uint8Array): string {
    return bytesToHex(bytes);
}

/** Bytes of a hex string, with or without a `0x` prefix. */
export function fromHex(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
        throw new Error(`invalid hex: ${hex.slice(0, 16)}`);
    }
    const out = new Uint8Array(clean.length / 2);
    for (let index = 0; index < out.length; index++) {
        out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
}

/** A copy of `length` bytes of `fill`. */
export function filled(length: number, fill: number): Uint8Array {
    return new Uint8Array(length).fill(fill);
}
