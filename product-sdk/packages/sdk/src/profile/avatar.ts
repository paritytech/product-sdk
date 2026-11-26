// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The avatar: its bytes through the host's preimage lookup, checked against
 * the CID, and the entry and the upload a publish makes. The fetch, timeout
 * and hash check reuse the SDK's verified content-addressed read; this module
 * maps a {@link ProfileAvatar} onto it and the declared format onto a MIME
 * type.
 */
import { blake2b256, bytesToHex } from "@parity/product-sdk-crypto";
import type { PreimageManager } from "@parity/product-sdk-host";
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
    type AvatarLookup,
    type AvatarMimeType,
    PROFILE_AVATAR_MAX_BYTES,
    type ProfileAvatar,
    type ProfileAvatarFormat,
} from "./types.js";

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

/**
 * The Bulletin preimage CID of a 32-byte digest, the form a record's digest is shown and fetched as.
 */
export function digestCid(digest: `0x${string}`): string {
    // A 32-byte digest always forms a CID.
    return (artworkAddress({ hex: digest, text: null }) as ArtworkAddress).cid;
}

const digestOf = (bytes: Uint8Array) => `0x${bytesToHex(blake2b256(bytes))}` as const;

/**
 * How long the host's preimage lookup is given before the avatar is reported
 * missing this time. A lookup is a subscription the host answers from its
 * cache or from Bulletin, so a first read can take a while.
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
 * Returns a `Result`. Whatever the bytes did is on the `ok` channel, see
 * {@link AvatarLookup}: only `Loaded` carries them, and none of the others
 * makes the profile failed, since the name and the CID still stand and the
 * next call asks again. The `err` channel is for a lookup that could not be
 * made: `Host` when the host threw, `Timeout` when its own deadline passed,
 * `Aborted` when `options.signal` fired.
 *
 * @example
 * ```ts
 * const manager = await getPreimageManager();
 * const loaded = profile.avatar && manager && (await loadAvatar(profile.avatar, manager));
 * if (loaded && loaded.ok && loaded.value.tag === "Loaded") {
 *     const { bytes, mimeType } = loaded.value.avatar;
 *     img.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
 * }
 * ```
 */
export async function loadAvatar(
    avatar: ProfileAvatar,
    manager: PreimageManager,
    options: LoadAvatarOptions = {},
): Promise<Result<AvatarLookup, ProfileError>> {
    const address = preimageCidAddress(avatar.cid);
    if (address === null) return ok({ tag: "Unreadable" });
    const source = preimageSource(manager, options.timeoutMs ?? DEFAULT_AVATAR_TIMEOUT_MS);
    // The RFC refuses an avatar over the bound. The lookup delivers the whole
    // value either way, so the bound is applied to what came back, before the
    // bytes are hashed.
    let oversized = false;
    const bounded: ArtworkSource = async (target, signal) => {
        const bytes = await source(target, signal);
        if (bytes === null || bytes.length <= PROFILE_AVATAR_MAX_BYTES) return bytes;
        oversized = true;
        return null;
    };
    const art = await getVerifiedArtwork(
        { hex: address.digest, text: avatar.cid },
        { source: bounded, signal: options.signal },
    );
    // An abort mid-lookup ends it empty-handed, which is not the host having
    // nothing: say so whichever way the read came back.
    if (options.signal?.aborted) {
        return err(
            new ProfileError("Aborted", "the avatar lookup was aborted", {
                cause: options.signal.reason,
            }),
        );
    }
    if (!art.ok) return err(hostCallFailed("the host did not answer the avatar lookup", art.error));
    if (oversized) return ok({ tag: "TooLarge" });
    if (art.value.tag !== "Verified") return ok({ tag: art.value.tag });
    return ok({
        tag: "Loaded",
        avatar: {
            cid: avatar.cid,
            format: avatar.format,
            mimeType: AVATAR_MIME_TYPES[avatar.format],
            bytes: art.value.bytes,
        },
    });
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
 * bytes go to Bulletin, and a write that would fail spends no allowance.
 * Bytes over {@link PROFILE_AVATAR_MAX_BYTES} are `TooLarge`. The format is
 * the caller's declaration; whether the bytes are an image of that format is
 * the product's check to make.
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
        key = (await manager.submit(bytes)).toLowerCase();
    } catch (cause) {
        return err(hostCallFailed("the host did not store the avatar", cause));
    }
    if (key !== digestOf(bytes)) {
        return err(
            new ProfileError(
                "Host",
                "the host stored the avatar under a key that is not the digest of its bytes",
            ),
        );
    }
    return ok(undefined);
}
