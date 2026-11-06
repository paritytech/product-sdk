// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Write a `profile` text-record value: one encoder per kind this module
 * knows, and the rewrite that applies a change to what a name already holds.
 *
 * The record on chain is one value, so every change is read, change, write
 * back; {@link rewriteProfileRecord} is the change. Its rules are the core's
 * where the core has one (`ProfileRecord::set_avatar` in host-rust-core) and
 * Seity's for the kinds the core does not yet know: an entry this writer cannot
 * read is carried byte for byte, a live record that is not a profile is
 * refused rather than replaced, and a record no reader would accept is never
 * produced.
 */
import { concatBytes, utf8ToBytes } from "@parity/product-sdk-crypto";
import { type Result, err, ok } from "@parity/result";

import { preimageCidAddress } from "./avatar.js";
import {
    isHex32,
    profileAvatarCodec,
    profileFeedCodec,
    profileNameCodec,
    profileNftCodec,
    profileRecordCodec,
} from "./codec.js";
import { ProfileError } from "./errors.js";
import { decodeRecordEntries, encodeBase64, readKnown } from "./record.js";
import {
    PROFILE_AVATAR_FORMATS,
    PROFILE_ENTRY_INDEX,
    PROFILE_NAME_MAX_BYTES,
    PROFILE_RECORD_MAX_BYTES,
    type ProfileAvatar,
    type ProfileFeed,
    type ProfileNft,
    type ProfilePatch,
} from "./types.js";

const invalid = (message: string) => err(new ProfileError("InvalidEntry", message));

/** One entry as the wrapper carries it: the variant index, then the payload. */
const entry = (index: number, payload: Uint8Array) => concatBytes(Uint8Array.of(index), payload);

/**
 * The CID must be a Bulletin preimage CID, the only address `loadAvatar` can
 * fetch through the host; any other string would publish an avatar no reader
 * shows.
 */
function encodeAvatar(avatar: ProfileAvatar): Result<Uint8Array, ProfileError> {
    const format = PROFILE_AVATAR_FORMATS.indexOf(avatar.format);
    if (format < 0) return invalid("the avatar format is not one the record can carry");
    if (preimageCidAddress(avatar.cid) === null) {
        return invalid("the avatar CID is not a Bulletin preimage CID");
    }
    const payload = profileAvatarCodec.enc({ cid: utf8ToBytes(avatar.cid), format });
    return ok(entry(PROFILE_ENTRY_INDEX.avatar, payload));
}

function encodeName(name: string): Result<Uint8Array, ProfileError> {
    const bytes = utf8ToBytes(name);
    if (bytes.length === 0) return invalid("a display name is not empty; clear it with null");
    if (bytes.length > PROFILE_NAME_MAX_BYTES) {
        return invalid(
            `a display name is at most ${PROFILE_NAME_MAX_BYTES} bytes of UTF-8, got ${bytes.length}`,
        );
    }
    return ok(entry(PROFILE_ENTRY_INDEX.name, profileNameCodec.enc(bytes)));
}

function encodeNft(nft: ProfileNft): Result<Uint8Array, ProfileError> {
    const isU32 = (id: number) => Number.isInteger(id) && id >= 0 && id <= 0xffff_ffff;
    // A pin that went through JSON comes back with its instance as a string,
    // which the range checks let through and the codec throws on.
    if (
        typeof nft.instance !== "bigint" ||
        nft.instance < 0n ||
        nft.instance > 0xffff_ffff_ffff_ffffn
    ) {
        return invalid("an instance id is a u64");
    }
    if (!isU32(nft.collection) || !isU32(nft.item)) {
        return invalid("a collection id and an item id are u32");
    }
    if (!isHex32(nft.purse)) return invalid("a purse is a 32-byte account id as 0x hex");
    return ok(entry(PROFILE_ENTRY_INDEX.nft, profileNftCodec.enc(nft)));
}

function encodeFeed(feed: ProfileFeed): Result<Uint8Array, ProfileError> {
    if (feed.kind === "") return invalid("a feed has a kind");
    if (!isHex32(feed.topic) || !isHex32(feed.signer)) {
        return invalid("a feed topic and signer are 32 bytes each as 0x hex");
    }
    const payload = profileFeedCodec.enc({ ...feed, kind: utf8ToBytes(feed.kind) });
    return ok(entry(PROFILE_ENTRY_INDEX.feed, payload));
}

/**
 * The text-record value holding `entries`, each as the wrapper carries it.
 * Refuses a record over {@link PROFILE_RECORD_MAX_BYTES}: every reader refuses
 * it too, so writing it would wipe the profile silently.
 */
export function encodeProfileRecord(entries: Uint8Array[]): Result<string, ProfileError> {
    const bytes = profileRecordCodec.enc(entries);
    if (bytes.length > PROFILE_RECORD_MAX_BYTES) {
        return err(
            new ProfileError(
                "TooLarge",
                `the profile record would be ${bytes.length} bytes, over the ${PROFILE_RECORD_MAX_BYTES}-byte bound`,
            ),
        );
    }
    return ok(encodeBase64(bytes));
}

/**
 * The text-record value after applying `patch` to what the name holds.
 *
 * `live` is the value the resolver holds now, `""` or `null` for none. A live
 * value that is not a profile is refused on the `err` channel, as the core's
 * publisher refuses it, so a damaged record is never overwritten by accident;
 * a product that means to replace it passes `null`.
 *
 * Per kind:
 *
 *   - A new avatar replaces the first avatar this writer can decode and goes
 *     first, ahead of every other entry, so it is the one every reader shows.
 *     An avatar in a format this writer does not know is kept, as the core
 *     keeps it. Clearing drops every avatar entry: with no new avatar in
 *     front, a kept one would be the avatar a newer reader shows.
 *   - A name replaces every name entry; `null` drops them.
 *   - Pins replace every pin entry as one list; `null` drops them.
 *   - Feeds replace the feed entries of the kinds they name and leave the
 *     others; `null` drops them all.
 *   - Every entry this writer cannot read is carried as read, whatever its
 *     index: an unknown kind, or a known kind whose payload does not decode,
 *     which the reader keeps as `unknown` too. The one exception is the
 *     avatar on clear, above.
 *
 * Replaced and added entries go after the carried ones, in the patch's order.
 */
export function rewriteProfileRecord(
    live: string | null | undefined,
    patch: ProfilePatch,
): Result<string, ProfileError> {
    const carried = live ? decodeRecordEntries(live) : ok<Uint8Array[]>([]);
    if (!carried.ok) return carried;
    const avatar = patch.avatar ? encodeAvatar(patch.avatar) : ok(null);
    if (!avatar.ok) return avatar;

    const replacedFeeds = new Set((patch.feeds ?? []).map((feed) => feed.kind));
    let avatarReplaced = false;
    const entries = carried.value.filter((carriedEntry) => {
        const known = readKnown(carriedEntry);
        // Not this writer's to drop, with one exception: on clear, an avatar in
        // a format this writer does not know goes too, or a newer reader would
        // still show it.
        if (known === null) {
            return carriedEntry[0] !== PROFILE_ENTRY_INDEX.avatar || patch.avatar !== null;
        }
        switch (known.kind) {
            case "avatar":
                if (avatar.value && !avatarReplaced) {
                    avatarReplaced = true;
                    return false;
                }
                return patch.avatar !== null;
            case "name":
                return patch.name === undefined;
            case "nft":
                return patch.nfts === undefined;
            case "feed":
                if (patch.feeds === undefined) return true;
                return patch.feeds !== null && !replacedFeeds.has(known.value.kind);
        }
    });
    if (avatar.value) entries.unshift(avatar.value);

    const added = [
        ...(typeof patch.name === "string" ? [encodeName(patch.name)] : []),
        ...(patch.nfts ?? []).map(encodeNft),
        ...(patch.feeds ?? []).map(encodeFeed),
    ];
    for (const encoded of added) {
        if (!encoded.ok) return encoded;
        entries.push(encoded.value);
    }
    return encodeProfileRecord(entries);
}
