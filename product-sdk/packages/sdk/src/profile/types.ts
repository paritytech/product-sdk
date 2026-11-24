// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The shapes of a public profile, from the core's public-profile RFC. The
 * names are the RFC's, so a later truapi-generated binding reads the same.
 */

/** The DotNS text-record key a public profile lives under. */
export const PROFILE_TEXT_RECORD_KEY = "profile";

/** Reader-side bound: a decoded record larger than this is not a profile. */
export const PROFILE_RECORD_MAX_BYTES = 16 * 1024;

/** Reader-side bound: avatar bytes over this are refused before they are checked against the CID. */
export const PROFILE_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The variant index of an `Avatar` entry: the byte that starts it. Entries of
 * every other index are kept as read, so a kind added later survives this
 * writer.
 */
export const PROFILE_AVATAR_ENTRY_INDEX = 0;

/**
 * The formats an avatar may be in. The index is what travels: `png` is 0,
 * `jpeg` is 1, `webp` is 2 and `gif` is 3, as the core's shared `ImageFormat`
 * numbers them.
 */
export const PROFILE_AVATAR_FORMATS = ["png", "jpeg", "webp", "gif"] as const;
export type ProfileAvatarFormat = (typeof PROFILE_AVATAR_FORMATS)[number];

/** Payload of an `Avatar` entry. */
export interface ProfileAvatar {
    /** Bulletin CID of the image bytes, raw codec, blake2b-256. The record carries its 32-byte digest. */
    cid: string;
    /** The image format, declared so no reader sniffs bytes. */
    format: ProfileAvatarFormat;
}

/**
 * What a reader gets from a record: the first `Avatar` entry that decodes, as
 * every host reads it, or `null` when none does.
 */
export interface PublicProfile {
    avatar: ProfileAvatar | null;
}

/**
 * What one write changes. `avatar` left `undefined` keeps the record's
 * avatar entries; `null` clears them.
 */
export interface ProfilePatch {
    avatar?: ProfileAvatar | null;
}

/**
 * What `getProfile` answers on the `ok` channel. `NoProfile` is a name with no
 * record, or none this reader can read; it is not a failure, so a caller
 * clears what it had cached. A chain that could not be asked is on the `err`
 * channel, and a caller keeps what it has.
 */
export type ProfileLookup = { tag: "Found"; profile: PublicProfile } | { tag: "NoProfile" };

/** The MIME type an avatar's declared format maps to. Never sniffed from the bytes. */
export type AvatarMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** An avatar fetched through the host and checked against its CID. */
export interface LoadedAvatar {
    /** For change detection: a product that keeps bytes by CID can skip the next fetch. */
    cid: string;
    format: ProfileAvatarFormat;
    mimeType: AvatarMimeType;
    /** The image bytes, which hash to `cid`. */
    bytes: Uint8Array;
}
