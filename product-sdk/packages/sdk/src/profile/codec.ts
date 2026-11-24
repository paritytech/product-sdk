// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * SCALE codecs for the profile record and its `Avatar` entry, byte for byte
 * what `parity_scale_codec` derives for the types in the RFC "Core-resolved
 * public profiles".
 *
 * The record is `Vec<WrapperKeepOpaque<ProfileEntry>>`: a compact count, then
 * each entry as its own length-prefixed bytes, the variant index first. The
 * wrapper lets a reader step over an entry it cannot decode, so the outer
 * codec reads entries as bytes and the reader decodes each one on its own.
 */
import { Bytes, type Codec, Hex, Struct, Vector, u8 } from "@polkadot-api/substrate-bindings";

/**
 * `ProfileRecord { entries: Vec<WrapperKeepOpaque<ProfileEntry>> }`: every entry as its bytes.
 *
 * @internal
 */
export const profileRecordCodec = Vector(Bytes());

/**
 * `ProfileAvatar { cid: BulletinCid, format: ImageFormat }`: the CID as its 32-byte blake2b-256 digest, the format as its index.
 *
 * @internal
 */
export const profileAvatarCodec = Struct({ cid: Hex(32), format: u8 });

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Decode `bytes` as exactly one value of `codec`, or `null`: the wrapper's
 * `decode_all`. scale-ts decoders ignore trailing bytes and accept a
 * truncated field or a non-minimal compact length, so the value must also
 * re-encode to `bytes`.
 *
 * @internal
 */
export function decodeExact<T>(codec: Codec<T>, bytes: Uint8Array): T | null {
    try {
        const value = codec.dec(bytes);
        return bytesEqual(codec.enc(value), bytes) ? value : null;
    } catch {
        return null;
    }
}
