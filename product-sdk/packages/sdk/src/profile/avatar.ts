// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The avatar: its bytes through the host's preimage lookup, checked against
 * the CID, and the entry and the upload a publish makes. The fetch, the
 * timeout and the hash check are the nfts package's `getVerifiedArtwork` over
 * `preimageSource`; this module maps a {@link ProfileAvatar} onto them and the
 * declared format onto a MIME type.
 */
import { blake2b256, bytesToHex } from "@parity/product-sdk-crypto";
import type { PreimageManager } from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import {
    type ArtworkAddress,
    type ArtworkSource,
    artworkAddress,
    getVerifiedArtwork,
    preimageSource,
} from "@parity/product-sdk-nfts";
import { type Result, err, ok } from "@parity/result";

import { ProfileError, hostCallFailed } from "./errors.js";
import {
    type AvatarMimeType,
    type LoadedAvatar,
    PROFILE_AVATAR_MAX_BYTES,
    type ProfileAvatar,
    type ProfileAvatarFormat,
} from "./types.js";

const log = createLogger("profile");

/** The multihash code of blake2b-256, the only digest a Bulletin preimage CID carries. */
const BLAKE2B_256 = 0xb220;

/**
 * `cid` as the address `loadAvatar` fetches by, or `null` when it is not a
 * Bulletin preimage CID: raw codec over a blake2b-256 digest. The one rule the
 * reader and the writer share for an acceptable avatar CID.
 */
export function preimageCidAddress(cid: string): ArtworkAddress | null {
    // An empty `hex` makes `artworkAddress` answer from the CID alone, with no
    // digest to fall back on.
    const address = artworkAddress({ hex: "", text: cid });
    return address !== null && address.multihash === BLAKE2B_256 ? address : null;
}

/** The Bulletin preimage CID of a 32-byte digest, the form a record's digest is shown and fetched as. */
export function digestCid(digest: `0x${string}`): string {
    // A 32-byte digest always forms a CID.
    return (artworkAddress({ hex: digest, text: null }) as ArtworkAddress).cid;
}

const digestOf = (bytes: Uint8Array) => `0x${bytesToHex(blake2b256(bytes))}` as const;

/**
 * How long the host's preimage lookup is given before the avatar is reported
 * missing this time. The core's `AVATAR_TIMEOUT`. A lookup is a subscription
 * the host answers from its cache or from Bulletin, so a first read can take
 * a while.
 */
const DEFAULT_AVATAR_TIMEOUT_MS = 30_000;

/** The MIME type each declared format maps to. */
const AVATAR_MIME_TYPES: Record<ProfileAvatarFormat, AvatarMimeType> = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
};

export interface LoadAvatarOptions {
    /** Default 30 s. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

/**
 * Fetch an avatar's bytes through the host and keep them only if they hash to
 * its CID.
 *
 * The key the host is asked for is the digest inside the CID, so no gateway is
 * involved and nobody outside the host learns whose avatar a viewer looks at.
 * The MIME type is the one the record declares; the bytes are never sniffed.
 *
 * `null` is "not this time": the host had no bytes under that key within the
 * timeout, answered bytes that do not hash to the CID or are over
 * {@link PROFILE_AVATAR_MAX_BYTES}, or the CID is not a raw blake2b-256
 * Bulletin CID at all. None of those makes the profile failed; the name and
 * the CID still stand, and the next call asks again.
 *
 * @example
 * ```ts
 * const manager = await getPreimageManager();
 * const avatar = profile.avatar && manager && (await loadAvatar(profile.avatar, manager));
 * if (avatar) img.src = URL.createObjectURL(new Blob([avatar.bytes as BlobPart], { type: avatar.mimeType }));
 * ```
 */
export async function loadAvatar(
    avatar: ProfileAvatar,
    manager: PreimageManager,
    options: LoadAvatarOptions = {},
): Promise<LoadedAvatar | null> {
    const address = preimageCidAddress(avatar.cid);
    if (address === null) {
        // Debug, not warn: the CID is the name owner's, not the caller's.
        log.debug("the avatar CID is not a Bulletin preimage CID", { cid: avatar.cid });
        return null;
    }
    const source = preimageSource(manager, options.timeoutMs ?? DEFAULT_AVATAR_TIMEOUT_MS);
    // The RFC refuses an avatar over the bound. The lookup delivers the whole
    // value either way, so the bound is applied to what came back, before the
    // bytes are hashed, and an oversized answer reads as missing.
    const bounded: ArtworkSource = async (target, signal) => {
        const bytes = await source(target, signal);
        if (bytes !== null && bytes.length > PROFILE_AVATAR_MAX_BYTES) {
            log.debug("the avatar is over the size bound; treating it as missing", {
                cid: avatar.cid,
                bytes: bytes.length,
            });
            return null;
        }
        return bytes;
    };
    const art = await getVerifiedArtwork(
        { hex: address.digest, text: avatar.cid },
        { source: bounded, signal: options.signal },
    );
    if (!art.ok) {
        if (options.signal?.aborted) log.debug("the avatar fetch was aborted", { cid: avatar.cid });
        else log.warn("the avatar fetch failed", { cid: avatar.cid, error: art.error.message });
        return null;
    }
    if (art.value.tag !== "Verified") {
        log.debug(`the avatar is ${art.value.tag.toLowerCase()} this time`, { cid: avatar.cid });
        return null;
    }
    return {
        cid: avatar.cid,
        format: avatar.format,
        mimeType: AVATAR_MIME_TYPES[avatar.format],
        bytes: art.value.bytes,
    };
}

const tooLarge = (bytes: Uint8Array) =>
    bytes.length > PROFILE_AVATAR_MAX_BYTES
        ? new ProfileError(
              "TooLarge",
              `the avatar is ${bytes.length} bytes, over the ${PROFILE_AVATAR_MAX_BYTES}-byte bound`,
          )
        : null;

/**
 * The {@link ProfileAvatar} a record carries for these bytes: their
 * blake2b-256 digest as a Bulletin CID, and the declared format.
 *
 * Pure, so the record can be rewritten and the write prepared before the
 * bytes go to Bulletin, the order the core's publisher keeps: a write that
 * would fail then spends no Bulletin allowance. `submitAvatar` stores the
 * bytes afterwards and holds the host to this same digest. Bytes over
 * {@link PROFILE_AVATAR_MAX_BYTES}, which every reader refuses, are
 * `TooLarge`. The format is the caller's declaration, as it is for the
 * reader; whether the bytes are an image of that format is the product's
 * check to make, with the file in hand.
 */
export function profileAvatar(
    bytes: Uint8Array,
    format: ProfileAvatarFormat,
): Result<ProfileAvatar, ProfileError> {
    const oversized = tooLarge(bytes);
    if (oversized) return err(oversized);
    return ok({ cid: digestCid(digestOf(bytes)), format });
}

/**
 * Store an avatar's bytes on Bulletin through the host.
 *
 * Call it after the write is prepared and before it is submitted, so the
 * record never names bytes that are not on Bulletin and a write that would
 * fail spends nothing. The key the host answers with must be the blake2b-256
 * digest of the bytes, the one `profileAvatar` put in the record; anything
 * else is `Host`. Submission spends the product's Bulletin allowance; the host
 * asks for it when none is held, and the bytes stay on Bulletin for its
 * retention period, after which the publisher uploads them again.
 *
 * `Timeout` is a host that did not confirm in time: the bytes may still be
 * stored, so a retry is safe and worth saying so. `Host` is any other failure.
 */
export async function submitAvatar(
    bytes: Uint8Array,
    manager: PreimageManager,
): Promise<Result<void, ProfileError>> {
    const oversized = tooLarge(bytes);
    if (oversized) return err(oversized);
    let key: string;
    try {
        key = await manager.submit(bytes);
    } catch (cause) {
        return err(hostCallFailed("the host did not store the avatar", cause));
    }
    if (key.toLowerCase() !== digestOf(bytes)) {
        return err(
            new ProfileError(
                "Host",
                "the host stored the avatar under a key that is not the digest of its bytes",
            ),
        );
    }
    return ok(undefined);
}
