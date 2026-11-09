// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk/profile — The public profile a person publishes under
 * their dotNS name: read it, and prepare the write that publishes it.
 *
 * A profile is one dotNS text record, `profile`, holding a SCALE
 * `ProfileRecord` in base64: a list of entries, each a length-prefixed byte
 * string that starts with the entry's variant index. Owning the name is the
 * authenticity. The envelope and the `Avatar` entry are fixed by the RFC
 * "Core-resolved public profiles" in host-rust-core, which the core decodes
 * with for hosts; the `Name` and `Feed` entries are proposed here, index 2 is
 * held for pinned NFTs with no payload yet, and
 * {@link PROFILE_ENTRY_INDEX} is the table where the next index is claimed. A
 * reader keeps every entry it cannot read, and a writer puts it back.
 *
 * The record lives on the deployment's content resolver, whatever resolver the
 * name itself points at. That is where dotNS keeps text records, where
 * dotns-sdk reads them, and where the host core's public-profile reader
 * (truapi `public_profile.rs`, not yet on main) reads and writes a profile;
 * this module does the same. Every name is minted pointing at the reverse
 * resolver and takes a `profile` record all the same, because the content
 * resolver's `setText` checks the registry's authorisation for the node and
 * not its pointer. So nothing here calls `setResolver`, and nothing should:
 * an address is read only while the pointer is the forward resolver, so
 * repointing a name that has an address record would lose it. A host that
 * follows the pointer for a product's `manifest` text does not read profiles
 * that way.
 *
 * Reads:
 *
 *   - `getProfile(label, opts)` finds and decodes the record, answering
 *     `ok({ tag: "Found", profile })`, `ok({ tag: "NoProfile" })` for a name
 *     with no readable profile, or `err` when the chain could not be asked.
 *     Keep the last two apart: the first clears a cached profile, the second
 *     keeps it.
 *   - `getProfileRecord(label, opts)` is the text as stored, `""` for none:
 *     what a write starts from. `decodeProfileRecord(text)` is the decoder
 *     alone.
 *   - `loadAvatar(avatar, manager)` fetches the avatar bytes through the host's
 *     preimage lookup and keeps them only if they hash to the CID and are
 *     within the RFC's bound. Never a gateway.
 *
 * Writes, in the order the core's publisher makes them:
 *
 *   1. `getProfileRecord` for the live text, with no origin: a read dry-runs
 *      as the origin it is given, and an unmapped one cannot.
 *   2. `submitAvatar(bytes, format, manager)` if the avatar changes: the bytes
 *      go to Bulletin through the host, and the CID comes back.
 *   3. `deriveMoodFeed(label, opts, store, deriveEntropy)` for the record's
 *      mood feed, in every publish: the topic and signer are stable per
 *      wallet and product, so the entry is the same each time, and it is in
 *      the record before any mood is set. Its proof needs the statement-store
 *      allowance, which the product requests before its first publish.
 *   4. `rewriteProfileRecord(live, patch)` for the new text, with the feed in
 *      the patch. It carries every entry the patch does not name, and refuses
 *      a live record that is not a profile rather than replacing it. To
 *      replace one on purpose, such as a record in the layout before the RFC,
 *      pass `null` as `live`: the new text is built from the patch alone.
 *   5. The product maps its account in pallet-revive if it never called a
 *      contract, before preparing: the dry-run that sizes the call runs as
 *      the origin, and an unmapped origin cannot dry-run.
 *   6. `prepareSetProfile(label, text, opts)` for the `setText` call, with
 *      `opts.origin` the account the registry authorises for the name. It
 *      hands back the text it saw, so the product reads once more and stops
 *      if another writer got there first.
 *   7. The product funds the account for the fee and the record's storage
 *      deposit and submits the call with its own signer, waiting for
 *      finality. None of that is the SDK's: who may write and who pays is
 *      the product's to decide.
 *   8. `verifyPublishedProfile(label, text, opts)` once the write is final.
 *
 * An empty text clears the record.
 *
 * Moods: the record's `mood` feed names a statement topic and a signer, and a
 * mood is one statement there, signed by the host's statement allowance key,
 * gone a day after it was set. `setMood(feed, mood, store)` sets or clears
 * it with no record write; `readMood(feed, store)` answers `ok(null)` for no
 * live mood and `err` when the host could not be read, which is "keep what
 * was shown", unlike `loadAvatar`'s null; `watchMood(feed, store, onChange)`
 * keeps answering. The palette, {@link MOOD_KINDS} and
 * {@link MOOD_INTENSITIES}, is fixed here so every product shows the same
 * intent for the same bytes; it grows by appending. The store is the host's,
 * from `getStatementStore()`. Other feed kinds are returned as data and not
 * subscribed to.
 *
 * @packageDocumentation
 */
export { decodeProfileRecord, decodeBase64Strict } from "./record.js";
export {
    getProfile,
    getProfileRecord,
    isAcceptableProfileLabel,
    normalizeProfileLabel,
    verifyPublishedProfile,
} from "./lookup.js";
export {
    loadAvatar,
    submitAvatar,
    AVATAR_MIME_TYPES,
    DEFAULT_AVATAR_TIMEOUT_MS,
} from "./avatar.js";
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
    DEFAULT_MOOD_READ_TIMEOUT_MS,
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
    ProfileEntryName,
    ProfileFeed,
    ProfileLookup,
    PublicProfile,
    UnknownEntry,
} from "./types.js";

// The inputs the lookup shares with every other dotNS read.
export type { DotNsClientOptions } from "../identity/dotns-registry.js";
export { DotNsError } from "../identity/dotns-errors.js";
export type { DotNsErrorReason } from "../identity/dotns-errors.js";
