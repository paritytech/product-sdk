// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The avatar bytes, through the host's preimage lookup and checked against the
 * CID. The fetch, the timeout and the hash check are the nfts package's
 * `getVerifiedArtwork` over `preimageSource`; this module maps a
 * {@link ProfileAvatar} onto them and the declared format onto a MIME type.
 */
import type { PreimageManager } from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import { artworkAddress, getVerifiedArtwork, preimageSource } from "@parity/product-sdk-nfts";

import type { AvatarMimeType, LoadedAvatar, ProfileAvatar, ProfileAvatarFormat } from "./types.js";

const log = createLogger("profile");

/** The multihash code of blake2b-256, the only digest a Bulletin preimage CID carries. */
const BLAKE2B_256 = 0xb220;

/**
 * How long the host's preimage lookup is given before the avatar is reported
 * missing this time. The core's `AVATAR_CEILING`. A lookup is a subscription
 * the host answers from its cache or from Bulletin, so a first read can take
 * a while.
 */
export const DEFAULT_AVATAR_TIMEOUT_MS = 60_000;

/** The MIME type each declared format maps to. */
export const AVATAR_MIME_TYPES: Record<ProfileAvatarFormat, AvatarMimeType> = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
};

export interface LoadAvatarOptions {
    /** Default {@link DEFAULT_AVATAR_TIMEOUT_MS}. */
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
 * timeout, answered bytes that do not hash to the CID, or the CID is not a
 * raw blake2b-256 Bulletin CID at all. None of those makes the profile
 * failed; the name and the CID still stand, and the next call asks again.
 *
 * @example
 * ```ts
 * const manager = await getPreimageManager();
 * const avatar = profile.avatar && manager && (await loadAvatar(profile.avatar, manager));
 * if (avatar) img.src = URL.createObjectURL(new Blob([avatar.bytes], { type: avatar.mimeType }));
 * ```
 */
export async function loadAvatar(
    avatar: ProfileAvatar,
    manager: PreimageManager,
    options: LoadAvatarOptions = {},
): Promise<LoadedAvatar | null> {
    // An empty `hex` makes `artworkAddress` answer from the CID alone, with no
    // digest to fall back on, so a CID that does not parse is `null` here.
    const address = artworkAddress({ hex: "", text: avatar.cid });
    if (address === null || address.multihash !== BLAKE2B_256) {
        log.warn("the avatar CID is not a Bulletin preimage CID", { cid: avatar.cid });
        return null;
    }
    const art = await getVerifiedArtwork(
        { hex: address.digest, text: avatar.cid },
        {
            source: preimageSource(manager, options.timeoutMs ?? DEFAULT_AVATAR_TIMEOUT_MS),
            signal: options.signal,
        },
    );
    if (!art.ok) {
        log.warn("the avatar fetch failed", { cid: avatar.cid, error: art.error.message });
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
