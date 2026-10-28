// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * SCALE codecs for the profile record and its tuple payloads, byte for byte
 * what `parity_scale_codec` derives for the structs in
 * `rust/crates/truapi/src/v01/profile.rs`.
 *
 * Strings are carried as `Bytes` rather than `str` on purpose. scale-ts's `str`
 * replaces invalid UTF-8 with U+FFFD, while the core's `String` decode fails
 * on it, so the UTF-8 check is made here with a fatal decoder and a bad string
 * is a failed decode, as it is in the core. The avatar format travels as its
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

/** `ProfileEntry { kind: String, payload: Vec<u8> }`, with `kind` left as bytes. */
export const profileEntryCodec = Struct({ kind: Bytes(), payload: Bytes() });

/** `ProfileRecord { entries: Vec<ProfileEntry> }`. */
export const profileRecordCodec = Struct({ entries: Vector(profileEntryCodec) });

/** `ProfileAvatar { cid: String, format: ProfileAvatarFormat }`, the format as its index. */
export const profileAvatarCodec = Struct({ cid: Bytes(), format: u8 });

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
 * `parity_scale_codec`'s `decode_all` refuses trailing bytes and a truncated
 * input; scale-ts decoders stop reading and say nothing about what is left,
 * and read a short tail as a shorter value. The check here is the one the
 * core's own test makes: the decoded value re-encodes to the writer's bytes.
 * Trailing bytes make the re-encoding shorter, a truncated field makes it
 * differ, and a value that does not decode at all is malformed.
 */
export function decodeExact<T>(codec: Codec<T>, bytes: Uint8Array): T | null {
    try {
        const value = codec.dec(bytes);
        return sameBytes(codec.enc(value), bytes) ? value : null;
    } catch {
        return null;
    }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

const strict = new TextDecoder("utf-8", { fatal: true });

/** `bytes` as a string, or `null` when they are not valid UTF-8. */
export function utf8OrNull(bytes: Uint8Array): string | null {
    try {
        return strict.decode(bytes);
    } catch {
        return null;
    }
}
