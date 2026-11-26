// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk/profile — the avatar a person publishes under their
 * DotNS name: read it, load its bytes, and prepare the write that sets or
 * clears it.
 *
 * A profile is one DotNS text record, `profile`, on the deployment's content
 * resolver: a SCALE `ProfileRecord` in base64, a list of entries each carried
 * as length-prefixed bytes that start with the entry's variant index. Owning
 * the name is the authenticity. The layout and the `Avatar` entry are the
 * core's (`public_profile` in trinity-user-agents), so what this module reads is
 * what hosts show. A writer carries every entry it does not read unchanged.
 *
 * `getProfile` answers one of three things, and the last two must be kept
 * apart: `ok({ tag: "Found", profile })`; `ok({ tag: "NoProfile" })` for a
 * name with no readable profile, which clears a cached one; and `err` when
 * the chain could not be asked, which keeps it.
 *
 * A write is read, change, write back, in the order the core's publisher
 * keeps. The SDK prepares each step; the product signs and submits as the
 * name's owner. Nothing here calls `setResolver`; `prepareSetProfile` says
 * why. Each step answers a `Result`; the checks are left out below.
 *
 * @example
 * ```ts
 * const live = await getProfileRecord("alice", { runtime }); // "" for none
 * const avatar = profileAvatar(pngBytes, "png"); // the entry, no host call
 * const text = rewriteProfileRecord(live.value, { avatar: avatar.value });
 * const prepared = await prepareSetProfile("alice", text.value, { runtime, origin });
 * await submitAvatar(pngBytes, manager); // after the dry-run, before the submit
 * // Read again and stop unless it is still `prepared.value.original`; submit
 * // `prepared.value.call` with the owner's signer; then, after finality:
 * await verifyPublishedProfile("alice", prepared.value.text, { runtime });
 * ```
 *
 * @packageDocumentation
 */
// Reads: the record and its decoder, and the avatar bytes through the host.
export { getProfile, getProfileRecord, verifyPublishedProfile } from "./lookup.js";
export { decodeProfileRecord } from "./record.js";
export { loadAvatar, profileAvatar, submitAvatar } from "./avatar.js";
export type { LoadAvatarOptions } from "./avatar.js";

// Writes: the rewrite, and the prepared `setText` the product signs and submits.
export { rewriteProfileRecord } from "./encode.js";
export { prepareSetProfile } from "./write.js";
export type { PreparedProfileWrite } from "./write.js";

// Errors: the profile's own, and the DotNS walk's, which every read and write shares.
export { ProfileError } from "./errors.js";
export type { ProfileErrorReason } from "./errors.js";
export { DotNsError } from "../identity/dotns-errors.js";
export type { DotNsErrorReason } from "../identity/dotns-errors.js";
export type { DotNsClientOptions } from "../identity/dotns-registry.js";

// The record's shapes and bounds.
export {
    PROFILE_AVATAR_FORMATS,
    PROFILE_AVATAR_MAX_BYTES,
    PROFILE_RECORD_MAX_BYTES,
    PROFILE_TEXT_RECORD_KEY,
} from "./types.js";
export type {
    AvatarLookup,
    AvatarMimeType,
    LoadedAvatar,
    ProfileAvatar,
    ProfileAvatarFormat,
    ProfileLookup,
    ProfilePatch,
    PublicProfile,
} from "./types.js";
