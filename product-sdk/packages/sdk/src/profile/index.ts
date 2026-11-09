// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk/profile — the public profile a person publishes under
 * their DotNS name: read it, and prepare the write that changes it.
 *
 * A profile is one DotNS text record, `profile`, on the deployment's content
 * resolver: a SCALE `ProfileRecord` in base64, a list of entries each carried
 * as length-prefixed bytes that start with the entry's variant index. Owning
 * the name is the authenticity. The envelope and the `Avatar` entry are the
 * core's (`public_profile` in trinity-user-agents), so what this module reads
 * is what hosts show; `Name` and `Feed` are proposed here, index 2 is
 * reserved, and {@link PROFILE_ENTRY_INDEX} is the table where the next index
 * is claimed. A reader keeps every entry it cannot read, and a writer puts it
 * back.
 *
 * `getProfile` answers one of three things, and the last two must be kept
 * apart: `ok({ tag: "Found", profile })`; `ok({ tag: "NoProfile" })` for a
 * name with no readable profile, which clears a cached one; and `err` when
 * the chain could not be asked, which keeps it.
 *
 * A write is read, change, write back, in the order the core's publisher
 * keeps. The SDK prepares each step; the product maps and funds its account,
 * signs and submits, as with every other DotNS write. Nothing here calls
 * `setResolver`; `prepareSetProfile` says why. Each step answers a `Result`;
 * the checks are left out below.
 *
 * @example
 * ```ts
 * const live = await getProfileRecord("alice", { runtime }); // "" for none
 * const avatar = profileAvatar(pngBytes, "png"); // the entry, no host call
 * const feed = await deriveMoodFeed("alice", { runtime }, store, deriveEntropy);
 * const text = rewriteProfileRecord(live.value, {
 *     avatar: avatar.value, name: "Alice", feeds: [feed.value],
 * });
 * const prepared = await prepareSetProfile("alice", text.value, { runtime, origin });
 * await submitAvatar(pngBytes, manager); // after the dry-run, before the submit
 * // Read again and stop unless it is still `prepared.value.original`; submit
 * // `prepared.value.call` with the owner's signer; then, after finality:
 * await verifyPublishedProfile("alice", prepared.value.text, { runtime });
 * ```
 *
 * Moods: the record's `mood` feed names a statement topic and a signer, and a
 * mood is one statement there, signed by the host's statement allowance key
 * and gone a day after it was set. `setMood` sets or clears it with no record
 * write; `readMood` answers `ok(null)` for none and `err` for a host that
 * could not be read, which is "keep what was shown"; `watchMood` keeps
 * answering. The palette, {@link MOOD_KINDS} and {@link MOOD_INTENSITIES}, is
 * fixed here and grows by appending, so every product shows the same intent
 * for the same bytes.
 *
 * @packageDocumentation
 */
export { decodeProfileRecord } from "./record.js";
export { getProfile, getProfileRecord, verifyPublishedProfile } from "./lookup.js";
export { loadAvatar, profileAvatar, submitAvatar } from "./avatar.js";
export type { LoadAvatarOptions } from "./avatar.js";
export { rewriteProfileRecord } from "./encode.js";
export { prepareSetProfile } from "./write.js";
export type { PreparedProfileWrite } from "./write.js";
export {
    deriveMoodFeed,
    setMood,
    readMood,
    watchMood,
    // The pure parts, for a fixture or a product that reads statements some other way.
    pickMood,
    encodeMoodBody,
    decodeMoodBody,
    moodExpiry,
    MOOD_FEED_KIND,
    MOOD_KINDS,
    MOOD_INTENSITIES,
    MOOD_TTL_SECS,
} from "./mood.js";
export type {
    DeriveEntropy,
    Mood,
    MoodChoice,
    MoodIntensity,
    MoodKind,
    MoodStatement,
    MoodWatch,
    ReadMoodOptions,
    WatchMoodOptions,
} from "./mood.js";
export { ProfileError } from "./errors.js";
export type { ProfileErrorReason } from "./errors.js";
export {
    PROFILE_AVATAR_FORMATS,
    PROFILE_AVATAR_MAX_BYTES,
    PROFILE_ENTRY_INDEX,
    PROFILE_NAME_MAX_BYTES,
    PROFILE_RECORD_MAX_BYTES,
    PROFILE_TEXT_RECORD_KEY,
} from "./types.js";
export type {
    AvatarMimeType,
    LoadedAvatar,
    ProfilePatch,
    ProfileAvatar,
    ProfileAvatarFormat,
    ProfileFeed,
    ProfileLookup,
    PublicProfile,
    UnknownEntry,
} from "./types.js";

// The inputs the lookup shares with every other dotNS read.
export type { DotNsClientOptions } from "../identity/dotns-registry.js";
export { DotNsError } from "../identity/dotns-errors.js";
export type { DotNsErrorReason } from "../identity/dotns-errors.js";
