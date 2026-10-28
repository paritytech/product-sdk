// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk/profile — Read the public profile a person publishes
 * under their dotNS name.
 *
 * A profile is one dotNS text record, `profile`, holding a SCALE
 * `ProfileRecord` in base64: an avatar, a display name, pinned NFTs and the
 * feeds the profile points at. Owning the name is the authenticity. The
 * shapes mirror `truapi::v01::profile` in the host core, which reads the same
 * record for hosts; a product reads it through here.
 *
 * Four reads, all read-only:
 *
 *   - `getProfile(label, opts)` finds and decodes the record, answering
 *     `ok(profile)`, `ok(null)` for a name with no readable profile, or `err`
 *     when the chain could not be asked. Keep the last two apart: the first
 *     clears a cached profile, the second keeps it.
 *   - `decodeProfileRecord(text)` is the decoder alone, for a record already
 *     in hand.
 *   - `loadAvatar(avatar, manager)` fetches the avatar bytes through the host's
 *     preimage lookup and keeps them only if they hash to the CID. Never a
 *     gateway.
 *   - `getPinnedNfts(chain, nfts)` confirms each pinned NFT against
 *     `Scarcity.Instances` and `getInstanceDisplays` at one block.
 *
 * Feeds are returned as data and not subscribed to; the mood feed comes in a
 * later phase. Nothing here signs or writes: the record's writer is the
 * product that owns the name.
 *
 * @packageDocumentation
 */
export { decodeProfileRecord, decodeBase64Strict } from "./record.js";
export { getProfile, isAcceptableProfileLabel, normalizeProfileLabel } from "./lookup.js";
export { loadAvatar, AVATAR_MIME_TYPES, DEFAULT_AVATAR_TIMEOUT_MS } from "./avatar.js";
export type { LoadAvatarOptions } from "./avatar.js";
export { getPinnedNfts } from "./pins.js";
export { ProfileError } from "./errors.js";
export type { ProfileErrorReason } from "./errors.js";
export {
    PROFILE_AVATAR_FORMATS,
    PROFILE_ENTRY_AVATAR,
    PROFILE_ENTRY_FEED,
    PROFILE_ENTRY_NAME,
    PROFILE_ENTRY_NFT,
    PROFILE_NAME_MAX_BYTES,
    PROFILE_RECORD_MAX_BYTES,
    PROFILE_TEXT_RECORD_KEY,
} from "./types.js";
export type {
    AvatarMimeType,
    DroppedPin,
    DroppedPinReason,
    LoadedAvatar,
    PinnedNft,
    PinnedNftsResult,
    ProfileAvatar,
    ProfileAvatarFormat,
    ProfileEntry,
    ProfileFeed,
    ProfileNft,
    ProfileNftsChain,
    ProfileRecord,
    PublicProfile,
} from "./types.js";

// The inputs the lookup shares with every other dotNS read.
export type { DotNsClientOptions } from "../identity/dotns-registry.js";
export { DotNsError } from "../identity/dotns-errors.js";
export type { DotNsErrorReason } from "../identity/dotns-errors.js";
