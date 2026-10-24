// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    _void,
    Bytes,
    type Codec,
    Enum,
    Option,
    Struct,
    Vector,
    bool,
    compact,
    str,
    u8,
    u16,
    u32,
    u64,
} from "scale-ts";

import { bytesEqual } from "../bytes.js";

/** SCALE `Vec<u8>`: compact length then the bytes. */
export const VecU8: Codec<Uint8Array> = Bytes();

/** SCALE `[u8; N]`: exactly `length` raw bytes. */
export function Fixed(length: number): Codec<Uint8Array> {
    return Bytes(length);
}

/** 32 raw bytes: account ids, topics, channels, X25519 keys. */
export const Bytes32 = Fixed(32);

/** A value that failed to decode. */
export class DecodeError extends Error {
    override readonly name = "DecodeError";
}

/**
 * Decodes `bytes` and refuses trailing or non-canonical bytes: the value must
 * re-encode to exactly the input. Use for transport frames.
 */
export function decodeStrict<T>(codec: Codec<T>, bytes: Uint8Array): T {
    const value = decodeLenient(codec, bytes);
    if (!bytesEqual(codec.enc(value), bytes)) {
        throw new DecodeError("trailing or non-canonical bytes");
    }
    return value;
}

/**
 * Decodes `bytes`, ignoring trailing bytes as the Android codec does. Use for
 * chat content, whose fields may only ever be appended.
 */
export function decodeLenient<T>(codec: Codec<T>, bytes: Uint8Array): T {
    try {
        return codec.dec(bytes);
    } catch (error) {
        throw new DecodeError(error instanceof Error ? error.message : String(error));
    }
}

/** Compact length prefix of `length`. */
export function compactLength(length: number): Uint8Array {
    return compact.enc(length);
}

/**
 * The `scale-ts` combinators, re-exported. Build codecs that nest this package's
 * codecs from these, not from another copy of `scale-ts`: a decoder hands the
 * codecs it nests its own read position, which a codec of another copy does not
 * recognise, so it reads from the start of the input and fails.
 */
export { _void, Bytes, compact, Enum, Option, Struct, Vector, bool, str, u8, u16, u32, u64 };
export type { Codec };
