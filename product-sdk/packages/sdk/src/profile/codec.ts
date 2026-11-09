// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * SCALE codecs for the profile record and its entry payloads, byte for byte
 * what `parity_scale_codec` derives for the types in the RFC "Core-resolved
 * public profiles" and the kinds proposed in `./types.ts`.
 *
 * The record is `Vec<WrapperKeepOpaque<ProfileEntry>>`: a compact count, then
 * each entry as its own length-prefixed byte string, inside which the first
 * byte is the variant index and the rest the variant's payload. The wrapper is
 * what lets a reader step over an entry it cannot decode, so the outer codec
 * here reads entries as bytes and the reader decodes each one on its own.
 *
 * Strings are carried as `Bytes` rather than `str` on purpose. scale-ts's `str`
 * replaces invalid UTF-8 with U+FFFD, while a SCALE `String` decode fails
 * on it, so the UTF-8 check is made here with a fatal decoder and a bad string
 * is a failed decode, as it is for every other reader. The avatar format travels as its
 * raw index and is mapped to a name by the reader, so an index the reader does
 * not know is a failed decode there too, matching `ProfileAvatarFormat`.
 */
import {
    Bytes,
    type Codec,
    Hex,
    Struct,
    Vector,
    u8,
    u32,
    u64,
} from "@polkadot-api/substrate-bindings";

/** `ProfileRecord { entries: Vec<WrapperKeepOpaque<ProfileEntry>> }`: every entry as its bytes. */
export const profileRecordCodec = Vector(Bytes());

/** `ProfileAvatar { cid: BulletinCid, format: ImageFormat }`: the CID as its 32-byte blake2b-256 digest, the format as its index. */
export const profileAvatarCodec = Struct({ cid: Hex(32), format: u8 });

/** `Name(String)`: a SCALE String, its compact length then the bytes, left as bytes for the UTF-8 check. */
export const profileNameCodec = Bytes();

/** `ProfileFeed { kind: String, topic: [u8; 32], signer: [u8; 32] }`, with `kind` left as bytes. */
export const profileFeedCodec = Struct({ kind: Bytes(), topic: Hex(32), signer: Hex(32) });

/**
 * A mood statement's body, `kind u8 | intensity u8 | set_at u64 | ttl_secs u32`,
 * 14 bytes: a layout already published, which is SCALE for this struct.
 * Not a record entry; it travels in the statement store.
 */
export const moodBodyCodec = Struct({ kind: u8, intensity: u8, setAt: u64, ttlSecs: u32 });

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Whether `value` is 32 bytes as `0x` hex: an account id, a topic, a signer. */
export function isHex32(value: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(value);
}

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
 */
export function decodeExact<T>(codec: Codec<T>, bytes: Uint8Array): T | null {
    try {
        const value = codec.dec(bytes);
        return bytesEqual(codec.enc(value), bytes) ? value : null;
    } catch {
        return null;
    }
}

// `ignoreBOM` keeps a leading U+FEFF as part of the text, as Rust's `String`
// decode does. Without it a name behind a byte-order mark would be three bytes
// shorter here than in a Rust reader, and the 64-byte rule would disagree.
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `bytes` as a string, or `null` when they are not valid UTF-8. */
export function utf8OrNull(bytes: Uint8Array): string | null {
    try {
        return strict.decode(bytes);
    } catch {
        return null;
    }
}
