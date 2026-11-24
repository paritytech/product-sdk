// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * SCALE codecs for the profile record and its `Avatar` entry, byte for byte
 * what `parity_scale_codec` derives for the types in the RFC "Core-resolved
 * public profiles".
 *
 * The record is `Vec<WrapperKeepOpaque<ProfileEntry>>`: a compact count, then
 * each entry as its own length-prefixed byte string, inside which the first
 * byte is the variant index and the rest the variant's payload. The wrapper is
 * what lets a reader step over an entry it cannot decode, so the outer codec
 * here reads entries as bytes and the reader decodes each one on its own. The
 * avatar format travels as its raw index and is mapped to a name by the
 * reader, so an index the reader does not know is a failed decode there,
 * matching the core's `ImageFormat`.
 */
import { Bytes, type Codec, Hex, Struct, Vector, u8 } from "@polkadot-api/substrate-bindings";

/**
 * `ProfileRecord { entries: Vec<WrapperKeepOpaque<ProfileEntry>> }`: every entry as its bytes.
 *
 * @internal For the module's own files and tests; consumers use the entry points.
 */
export const profileRecordCodec = Vector(Bytes());

/**
 * `ProfileAvatar { cid: BulletinCid, format: ImageFormat }`: the CID as its 32-byte blake2b-256 digest, the format as its index.
 *
 * @internal For the module's own files and tests; consumers use the entry points.
 */
export const profileAvatarCodec = Struct({ cid: Hex(32), format: u8 });

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Decode `bytes` as exactly one value of `codec`, or `null`.
 *
 * This is the wrapper's rule: `WrapperKeepOpaque` decodes its bytes with
 * `decode_all`, which refuses trailing bytes and a truncated input, and keeps
 * the bytes opaque when that fails. scale-ts decoders stop reading and say
 * nothing about what is left, and read a short tail as a shorter value. The
 * check here is the re-encoding one: the decoded value re-encodes
 * to the writer's bytes. Trailing bytes make the re-encoding shorter, a
 * truncated field makes it differ, a non-minimal compact length re-encodes
 * minimal, and a value that does not decode at all is not one value.
 *
 * @internal For the module's own files and tests; consumers use the entry points.
 */
export function decodeExact<T>(codec: Codec<T>, bytes: Uint8Array): T | null {
    try {
        const value = codec.dec(bytes);
        return bytesEqual(codec.enc(value), bytes) ? value : null;
    } catch {
        return null;
    }
}
