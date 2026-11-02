// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Read a `profile` text-record value into a {@link PublicProfile}, by the
 * RFC's reader rules and the per-kind rules in {@link PROFILE_ENTRY_INDEX}.
 */
import { type Result, err, ok } from "@parity/result";

import {
    decodeExact,
    profileAvatarCodec,
    profileFeedCodec,
    profileNameCodec,
    profileNftCodec,
    profileRecordCodec,
    utf8OrNull,
} from "./codec.js";
import { ProfileError } from "./errors.js";
import {
    PROFILE_AVATAR_FORMATS,
    PROFILE_ENTRY_INDEX,
    PROFILE_NAME_MAX_BYTES,
    PROFILE_RECORD_MAX_BYTES,
    type ProfileAvatar,
    type ProfileFeed,
    type ProfileNft,
    type PublicProfile,
} from "./types.js";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Standard base64 with padding, the one form the writer emits, decoded the way
 * the core's `decode_base64` does it: the length a multiple of four, at most
 * two padding characters, every digit in the alphabet, and the bits a final
 * partial group leaves over all zero. `null` for anything else. `atob` is not
 * used because it accepts what the core refuses.
 */
export function decodeBase64Strict(text: string): Uint8Array | null {
    const unpadded = text.replace(/=+$/, "");
    if (text.length - unpadded.length > 2 || text.length % 4 !== 0) return null;
    const out: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const digit of unpadded) {
        const value = BASE64_ALPHABET.indexOf(digit);
        if (value < 0) return null;
        buffer = ((buffer << 6) | value) >>> 0;
        bits += 6;
        if (bits >= 8) {
            out.push((buffer >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    if ((buffer & ((1 << bits) - 1)) !== 0) return null;
    return new Uint8Array(out);
}

/**
 * Decode a `profile` text-record value.
 *
 * Pure. The text is standard base64 of a SCALE `ProfileRecord`. A value that
 * is not base64, is over {@link PROFILE_RECORD_MAX_BYTES} before parsing, or
 * is not exactly one record comes back on the `err` channel; `getProfile`
 * treats every one of those as a name with no profile, as the core does.
 *
 * Within a record that decodes, each entry is read on its own, as the RFC's
 * `WrapperKeepOpaque` reads it: the first `Avatar` whose payload decodes to a
 * format this reader knows wins, the first non-empty `Name` of at most 64
 * bytes of valid UTF-8 wins, every `Nft` and `Feed` that decodes is kept in
 * order, and every entry this reader cannot read, whether its index is unknown
 * or its payload is not one value of its kind, is kept as it was.
 *
 * @example
 * ```ts
 * const profile = decodeProfileRecord(text);
 * if (profile.ok) {
 *     heading.textContent = profile.value.name ?? label;
 * }
 * ```
 */
export function decodeProfileRecord(text: string): Result<PublicProfile, ProfileError> {
    const bytes = decodeBase64Strict(text);
    if (bytes === null) {
        return err(new ProfileError("NotBase64", "the profile record is not standard base64"));
    }
    if (bytes.length > PROFILE_RECORD_MAX_BYTES) {
        return err(
            new ProfileError(
                "TooLarge",
                `the profile record is ${bytes.length} bytes, over the ${PROFILE_RECORD_MAX_BYTES}-byte bound`,
            ),
        );
    }
    const entries = decodeExact(profileRecordCodec, bytes);
    if (entries === null) {
        return err(
            new ProfileError(
                "Malformed",
                "the profile record is not exactly one SCALE ProfileRecord",
            ),
        );
    }
    return ok(readEntries(entries));
}

/** The avatar a payload holds, or `null` when it is not one avatar in a format this reader knows. */
function readAvatar(payload: Uint8Array): ProfileAvatar | null {
    const decoded = decodeExact(profileAvatarCodec, payload);
    if (decoded === null) return null;
    const cid = utf8OrNull(decoded.cid);
    const format = PROFILE_AVATAR_FORMATS[decoded.format];
    return cid !== null && format !== undefined ? { cid, format } : null;
}

/**
 * The name a payload holds with its length in bytes, or `null` when it is not
 * one UTF-8 String. Whether the name is one this reader uses is the caller's
 * rule: an empty or over-long name is still a known entry.
 */
function readName(payload: Uint8Array): { text: string; byteLength: number } | null {
    const bytes = decodeExact(profileNameCodec, payload);
    if (bytes === null) return null;
    const text = utf8OrNull(bytes);
    return text === null ? null : { text, byteLength: bytes.length };
}

function readNft(payload: Uint8Array): ProfileNft | null {
    const decoded = decodeExact(profileNftCodec, payload);
    return decoded === null
        ? null
        : {
              instance: decoded.instance,
              collection: decoded.collection,
              item: decoded.item,
              purse: decoded.purse as `0x${string}`,
          };
}

function readFeed(payload: Uint8Array): ProfileFeed | null {
    const decoded = decodeExact(profileFeedCodec, payload);
    if (decoded === null) return null;
    const kind = utf8OrNull(decoded.kind);
    return kind === null
        ? null
        : {
              kind,
              topic: decoded.topic as `0x${string}`,
              signer: decoded.signer as `0x${string}`,
          };
}

function readEntries(entries: Uint8Array[]): PublicProfile {
    const profile: PublicProfile = { avatar: null, name: null, nfts: [], feeds: [], unknown: [] };
    for (const entry of entries) {
        if (!readEntry(entry, profile)) profile.unknown.push({ bytes: entry });
    }
    return profile;
}

/**
 * Read one entry into `profile`. `false` when the entry is not one value of a
 * kind this reader knows, which is the wrapper's cue to keep it as read.
 */
function readEntry(entry: Uint8Array, profile: PublicProfile): boolean {
    if (entry.length === 0) return false;
    // A copy, not a view: the scale-ts decoders read from the start of the
    // backing buffer and ignore a view's `byteOffset`, so a `subarray` would
    // hand them the index byte and whatever precedes it.
    const payload = entry.slice(1);
    switch (entry[0]) {
        case PROFILE_ENTRY_INDEX.avatar: {
            const avatar = readAvatar(payload);
            if (avatar === null) return false;
            profile.avatar ??= avatar;
            return true;
        }
        case PROFILE_ENTRY_INDEX.name: {
            const name = readName(payload);
            if (name === null) return false;
            // A known entry either way; only a non-empty name within the bound is used.
            if (name.byteLength > 0 && name.byteLength <= PROFILE_NAME_MAX_BYTES) {
                profile.name ??= name.text;
            }
            return true;
        }
        case PROFILE_ENTRY_INDEX.nft: {
            const nft = readNft(payload);
            if (nft === null) return false;
            profile.nfts.push(nft);
            return true;
        }
        case PROFILE_ENTRY_INDEX.feed: {
            const feed = readFeed(payload);
            if (feed === null) return false;
            profile.feeds.push(feed);
            return true;
        }
        default:
            return false;
    }
}
