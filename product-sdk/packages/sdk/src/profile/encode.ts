// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Write a `profile` text-record value. The record on chain is one value, so
 * every change is read, change, write back; {@link rewriteProfileRecord} is
 * the change.
 */
import { concatBytes } from "@parity/product-sdk-crypto";
import { type Result, err, ok } from "@parity/result";
import { preimageCidAddress } from "./avatar.js";
import { profileAvatarCodec, profileRecordCodec } from "./codec.js";
import { ProfileError } from "./errors.js";
import { decodeRecordEntries, encodeBase64, readAvatarEntry } from "./record.js";
import {
    PROFILE_AVATAR_ENTRY_INDEX,
    PROFILE_AVATAR_FORMATS,
    PROFILE_RECORD_MAX_BYTES,
    type ProfileAvatar,
    type ProfilePatch,
} from "./types.js";

const invalid = (message: string) => err(new ProfileError("InvalidEntry", message));

/**
 * The CID must be a Bulletin preimage CID, the only address `loadAvatar` can
 * fetch through the host, and the record carries only its digest: any other
 * CID has no place in the entry and would publish an avatar no reader shows.
 */
function encodeAvatar(avatar: ProfileAvatar): Result<Uint8Array, ProfileError> {
    const format = PROFILE_AVATAR_FORMATS.indexOf(avatar.format);
    if (format < 0) return invalid("the avatar format is not one the record can carry");
    const address = preimageCidAddress(avatar.cid);
    if (address === null) return invalid("the avatar CID is not a Bulletin preimage CID");
    const payload = profileAvatarCodec.enc({ cid: address.digest, format });
    return ok(concatBytes(Uint8Array.of(PROFILE_AVATAR_ENTRY_INDEX), payload));
}

/**
 * The text-record value holding `entries`, each as the wrapper carries it.
 * Refuses a record over {@link PROFILE_RECORD_MAX_BYTES}: every reader refuses
 * it too, so writing it would wipe the profile silently.
 *
 * @internal
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
 * value that is not a profile is refused on the `err` channel, so a damaged
 * record is never overwritten by accident; a product that means to replace it
 * passes `null`.
 *
 *   - A new avatar replaces the avatar readers show, the first that decodes,
 *     and goes first, ahead of every other entry.
 *   - `avatar: null` drops every avatar entry, including one in a format this
 *     writer does not know: a kept one would be the avatar a newer reader
 *     shows.
 *   - Every other entry is carried as read, in its order.
 */
export function rewriteProfileRecord(
    live: string | null | undefined,
    patch: ProfilePatch,
): Result<string, ProfileError> {
    const carried = live?.trim() ? decodeRecordEntries(live) : ok<Uint8Array[]>([]);
    if (!carried.ok) return carried;
    if (patch.avatar === undefined) return encodeProfileRecord(carried.value);
    if (patch.avatar === null) {
        return encodeProfileRecord(
            carried.value.filter((entry) => entry[0] !== PROFILE_AVATAR_ENTRY_INDEX),
        );
    }
    const avatar = encodeAvatar(patch.avatar);
    if (!avatar.ok) return avatar;
    const shown = carried.value.findIndex((entry) => readAvatarEntry(entry) !== null);
    const others = carried.value.filter((_, index) => index !== shown);
    return encodeProfileRecord([avatar.value, ...others]);
}
