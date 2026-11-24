// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Read a `profile` text-record value into a {@link PublicProfile}, by the
 * RFC's reader rules.
 */
import { type Result, err, ok } from "@parity/result";
import { digestCid } from "./avatar.js";
import { decodeExact, profileAvatarCodec, profileRecordCodec } from "./codec.js";
import { ProfileError } from "./errors.js";
import {
    PROFILE_AVATAR_ENTRY_INDEX,
    PROFILE_AVATAR_FORMATS,
    PROFILE_RECORD_MAX_BYTES,
    type ProfileAvatar,
    type PublicProfile,
} from "./types.js";

/**
 * Standard base64 with padding, the one form the writer emits, decoded the way
 * a strict decoder does it: the text must be the canonical encoding of its
 * bytes, so missing or surplus padding, set trailing bits, whitespace and the
 * URL alphabet are all refused. `atob` alone accepts most of those; the
 * round-trip through `btoa` is what refuses them.
 *
 * @internal For the module's own files and tests; consumers use the entry points.
 */
export function decodeBase64Strict(text: string): Uint8Array | null {
    let binary: string;
    try {
        binary = atob(text);
    } catch {
        return null;
    }
    if (btoa(binary) !== text) return null;
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Standard base64 with padding: the one form the writer emits, and what {@link decodeBase64Strict} reads back.
 *
 * @internal For the module's own files and tests; consumers use the entry points.
 */
export function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** The longest base64 text whose bytes can fit {@link PROFILE_RECORD_MAX_BYTES}. */
const MAX_RECORD_TEXT_LENGTH = 4 * Math.ceil(PROFILE_RECORD_MAX_BYTES / 3);

const recordTooLarge = () =>
    new ProfileError(
        "TooLarge",
        `the profile record is over the ${PROFILE_RECORD_MAX_BYTES}-byte bound`,
    );

/**
 * The entries of a `profile` text-record value, each as the wrapper carries
 * it: the index byte, then the payload. The outer layer only; what each entry
 * holds is the reader's or the rewriter's question. The three errors are the
 * ones every reader refuses a record for.
 *
 * @internal For the module's own files and tests; consumers use the entry points.
 */
export function decodeRecordEntries(text: string): Result<Uint8Array[], ProfileError> {
    const trimmed = text.trim();
    // The record is someone else's: refuse an oversized one before decoding it.
    if (trimmed.length > MAX_RECORD_TEXT_LENGTH) return err(recordTooLarge());
    const bytes = decodeBase64Strict(trimmed);
    if (bytes === null) {
        return err(new ProfileError("NotBase64", "the profile record is not standard base64"));
    }
    if (bytes.length > PROFILE_RECORD_MAX_BYTES) return err(recordTooLarge());
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
 * as every reader trims it. A value that is not base64, is over
 * {@link PROFILE_RECORD_MAX_BYTES} before parsing, or is not exactly one record
 * comes back on the `err` channel; `getProfile` treats every one of those as a
 * name with no profile, as a host does.
 *
 * The avatar is the first entry that decodes as one; every other entry is
 * skipped.
 *
 * @example
 * ```ts
 * const profile = decodeProfileRecord(text);
 * if (profile.ok && profile.value.avatar) show(profile.value.avatar.cid);
 * ```
 */
export function decodeProfileRecord(text: string): Result<PublicProfile, ProfileError> {
    const entries = decodeRecordEntries(text);
    if (!entries.ok) return entries;
    for (const entry of entries.value) {
        const avatar = readAvatarEntry(entry);
        if (avatar) return ok({ avatar });
    }
    return ok({ avatar: null });
}

/**
 * The avatar an entry holds, or `null` when it is not an `Avatar` entry whose
 * payload is exactly one digest and a format this reader knows. The one rule
 * the reader and the writer share for what counts as an avatar.
 *
 * @internal For the module's own files and tests; consumers use the entry points.
 */
export function readAvatarEntry(entry: Uint8Array): ProfileAvatar | null {
    if (entry[0] !== PROFILE_AVATAR_ENTRY_INDEX) return null;
    // A copy, not a view: the scale-ts decoders read from the start of the
    // backing buffer and ignore a view's `byteOffset`, so a `subarray` would
    // hand them the index byte and whatever precedes it.
    const decoded = decodeExact(profileAvatarCodec, entry.slice(1));
    if (decoded === null) return null;
    const format = PROFILE_AVATAR_FORMATS[decoded.format];
    return format === undefined ? null : { cid: digestCid(decoded.cid as `0x${string}`), format };
}
