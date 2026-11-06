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
/** Digit value by character code, -1 for anything outside the alphabet. */
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64_ALPHABET.length; i++) BASE64_VALUE[BASE64_ALPHABET.charCodeAt(i)] = i;

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
    const out = new Uint8Array((unpadded.length * 6) >>> 3);
    let written = 0;
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < unpadded.length; i++) {
        const code = unpadded.charCodeAt(i);
        const value = code < BASE64_VALUE.length ? (BASE64_VALUE[code] as number) : -1;
        if (value < 0) return null;
        buffer = ((buffer << 6) | value) >>> 0;
        bits += 6;
        if (bits >= 8) {
            out[written++] = (buffer >>> (bits - 8)) & 0xff;
            bits -= 8;
        }
    }
    if ((buffer & ((1 << bits) - 1)) !== 0) return null;
    return out;
}

/** Standard base64 with padding: the one form the writer emits, and what {@link decodeBase64Strict} reads back. */
export function encodeBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i] as number;
        const b = bytes[i + 1];
        const c = bytes[i + 2];
        const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
        out += BASE64_ALPHABET[(triple >>> 18) & 63];
        out += BASE64_ALPHABET[(triple >>> 12) & 63];
        out += b === undefined ? "=" : BASE64_ALPHABET[(triple >>> 6) & 63];
        out += c === undefined ? "=" : BASE64_ALPHABET[triple & 63];
    }
    return out;
}

/**
 * The entries of a `profile` text-record value, each as the wrapper carries
 * it: the index byte, then the payload. The outer layer only; what each entry
 * holds is the reader's or the rewriter's question. The three errors are the
 * ones the core's `from_text` refuses a record for.
 */
export function decodeRecordEntries(text: string): Result<Uint8Array[], ProfileError> {
    const bytes = decodeBase64Strict(text.trim());
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
    return ok(entries);
}

/**
 * Decode a `profile` text-record value.
 *
 * Pure. The text is standard base64 of a SCALE `ProfileRecord`, trimmed first
 * as the core's `from_text` trims it. A value that is not base64, is over
 * {@link PROFILE_RECORD_MAX_BYTES} before parsing, or is not exactly one record
 * comes back on the `err` channel; `getProfile` treats every one of those as a
 * name with no profile, as the core does.
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
    const entries = decodeRecordEntries(text);
    if (!entries.ok) return entries;
    return ok(readEntries(entries.value));
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

/** An entry of a kind this module knows, decoded. The `kind` is its name in {@link PROFILE_ENTRY_INDEX}. */
export type KnownEntry =
    | { kind: "avatar"; value: ProfileAvatar }
    | { kind: "name"; value: { text: string; byteLength: number } }
    | { kind: "nft"; value: ProfileNft }
    | { kind: "feed"; value: ProfileFeed };

/**
 * One entry as a value of the kind its index names, or `null` when it is not
 * one: an index this module does not know, or a payload that does not decode.
 * The one table from the index to the reader, for the reader, which keeps a
 * null as `unknown`, and the writer, which carries it as read. Claiming a new
 * index means a case here, a field on the patch, and a vector in the tests.
 */
export function readKnown(entry: Uint8Array): KnownEntry | null {
    if (entry.length === 0) return null;
    // A copy, not a view: the scale-ts decoders read from the start of the
    // backing buffer and ignore a view's `byteOffset`, so a `subarray` would
    // hand them the index byte and whatever precedes it.
    const payload = entry.slice(1);
    switch (entry[0]) {
        case PROFILE_ENTRY_INDEX.avatar: {
            const value = readAvatar(payload);
            return value && { kind: "avatar", value };
        }
        case PROFILE_ENTRY_INDEX.name: {
            const value = readName(payload);
            return value && { kind: "name", value };
        }
        case PROFILE_ENTRY_INDEX.nft: {
            const value = readNft(payload);
            return value && { kind: "nft", value };
        }
        case PROFILE_ENTRY_INDEX.feed: {
            const value = readFeed(payload);
            return value && { kind: "feed", value };
        }
        default:
            return null;
    }
}

/** Read one entry into `profile`. `false` when it is not a known entry, the wrapper's cue to keep it as read. */
function readEntry(entry: Uint8Array, profile: PublicProfile): boolean {
    const known = readKnown(entry);
    if (known === null) return false;
    switch (known.kind) {
        case "avatar":
            profile.avatar ??= known.value;
            break;
        case "name":
            // A known entry either way; only a non-empty name within the bound is used.
            if (known.value.byteLength > 0 && known.value.byteLength <= PROFILE_NAME_MAX_BYTES) {
                profile.name ??= known.value.text;
            }
            break;
        case "nft":
            profile.nfts.push(known.value);
            break;
        case "feed":
            profile.feeds.push(known.value);
            break;
    }
    return true;
}
