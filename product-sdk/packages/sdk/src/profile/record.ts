// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Read a `profile` text-record value into a {@link PublicProfile}, by the rules
 * the core's `ProfileRecord::decode_bounded`, `avatar()` and `name()` apply.
 */
import { type Result, err, ok } from "@parity/result";

import {
    decodeExact,
    profileAvatarCodec,
    profileFeedCodec,
    profileNftCodec,
    profileRecordCodec,
    utf8OrNull,
} from "./codec.js";
import { ProfileError } from "./errors.js";
import {
    PROFILE_AVATAR_FORMATS,
    PROFILE_ENTRY_AVATAR,
    PROFILE_ENTRY_FEED,
    PROFILE_ENTRY_NAME,
    PROFILE_ENTRY_NFT,
    PROFILE_NAME_MAX_BYTES,
    PROFILE_RECORD_MAX_BYTES,
    type ProfileAvatar,
    type ProfileEntry,
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
 * Within a record that decodes, an entry of a known kind that does not read
 * is skipped rather than fatal: the first `avatar` whose payload decodes to a
 * format this reader knows wins, the first `name` of at most 64 valid UTF-8
 * bytes wins, every `nft` and `feed` that decodes is kept in order, and every
 * entry of an unknown kind is kept as it was.
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
    const record = decodeExact(profileRecordCodec, bytes);
    if (record === null) {
        return err(
            new ProfileError(
                "Malformed",
                "the profile record is not exactly one SCALE ProfileRecord",
            ),
        );
    }
    const entries: ProfileEntry[] = [];
    for (const entry of record.entries) {
        const kind = utf8OrNull(entry.kind);
        if (kind === null) {
            return err(new ProfileError("Malformed", "a profile entry kind is not UTF-8"));
        }
        entries.push({ kind, payload: entry.payload });
    }
    return ok(readEntries(entries));
}

/** The first avatar whose payload decodes to a format this reader knows. */
function readAvatar(payload: Uint8Array): ProfileAvatar | null {
    const decoded = decodeExact(profileAvatarCodec, payload);
    if (decoded === null) return null;
    const cid = utf8OrNull(decoded.cid);
    const format = PROFILE_AVATAR_FORMATS[decoded.format];
    return cid !== null && format !== undefined ? { cid, format } : null;
}

function readName(payload: Uint8Array): string | null {
    return payload.length <= PROFILE_NAME_MAX_BYTES ? utf8OrNull(payload) : null;
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

function readEntries(entries: ProfileEntry[]): PublicProfile {
    const profile: PublicProfile = { avatar: null, name: null, nfts: [], feeds: [], unknown: [] };
    for (const entry of entries) {
        switch (entry.kind) {
            case PROFILE_ENTRY_AVATAR:
                profile.avatar ??= readAvatar(entry.payload);
                break;
            case PROFILE_ENTRY_NAME:
                profile.name ??= readName(entry.payload);
                break;
            case PROFILE_ENTRY_NFT: {
                const nft = readNft(entry.payload);
                if (nft !== null) profile.nfts.push(nft);
                break;
            }
            case PROFILE_ENTRY_FEED: {
                const feed = readFeed(entry.payload);
                if (feed !== null) profile.feeds.push(feed);
                break;
            }
            default:
                profile.unknown.push(entry);
        }
    }
    return profile;
}
