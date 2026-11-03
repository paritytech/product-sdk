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
 * replaces invalid UTF-8 with U+FFFD, while the core's `String` decode fails
 * on it, so the UTF-8 check is made here with a fatal decoder and a bad string
 * is a failed decode, as it is in the core. The avatar format travels as its
 * raw index and is mapped to a name by the reader, so an index the reader does
 * not know is a failed decode there too, matching `ProfileAvatarFormat`.
 */
import { publicKeysEqual } from "@parity/product-sdk-address";
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

/** `ProfileAvatar { cid: String, format: ProfileAvatarFormat }`, the format as its index. */
export const profileAvatarCodec = Struct({ cid: Bytes(), format: u8 });

/** `Name(String)`: a SCALE String, its compact length then the bytes, left as bytes for the UTF-8 check. */
export const profileNameCodec = Bytes();

/** `ProfileNft { instance: u64, collection: u32, item: u32, purse: [u8; 32] }`. */
export const profileNftCodec = Struct({
    instance: u64,
    collection: u32,
    item: u32,
    purse: Hex(32),
});

/** `ProfileFeed { kind: String, topic: [u8; 32], signer: [u8; 32] }`, with `kind` left as bytes. */
export const profileFeedCodec = Struct({ kind: Bytes(), topic: Hex(32), signer: Hex(32) });

/**
 * Decode `bytes` as exactly one value of `codec`, or `null`.
 *
 * This is the wrapper's rule: `WrapperKeepOpaque` decodes its bytes with
 * `decode_all`, which refuses trailing bytes and a truncated input, and keeps
 * the bytes opaque when that fails. scale-ts decoders stop reading and say
 * nothing about what is left, and read a short tail as a shorter value. The
 * check here is the one the core's own test makes: the decoded value re-encodes
 * to the writer's bytes. Trailing bytes make the re-encoding shorter, a
 * truncated field makes it differ, a non-minimal compact length re-encodes
 * minimal, and a value that does not decode at all is not one value.
 */
export function decodeExact<T>(codec: Codec<T>, bytes: Uint8Array): T | null {
    try {
        const value = codec.dec(bytes);
        return publicKeysEqual(codec.enc(value), bytes) ? value : null;
    } catch {
        return null;
    }
}

// `ignoreBOM` keeps a leading U+FEFF as part of the text, as Rust's `String`
// decode does. Without it a name behind a byte-order mark would be three bytes
// shorter here than in the core, and the 64-byte rule would disagree.
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `bytes` as a string, or `null` when they are not valid UTF-8. */
export function utf8OrNull(bytes: Uint8Array): string | null {
    try {
        return strict.decode(bytes);
    } catch {
        return null;
    }
}
