// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * NFT pins, checked against the chain. A pin says "this purse holds this
 * instance, minted from this collection and item"; the chain says whether that
 * is still so. The displays come from the nfts package, the owner from
 * `Scarcity.Instances`, both at one block.
 */
import { accountIdBytes, publicKeysEqual } from "@parity/product-sdk-address";
import {
    type FinalizedSnapshot,
    type InstanceDisplay,
    MAX_INSTANCES_PER_READ,
    type PinnedReadOptions,
    getInstanceDisplays,
} from "@parity/product-sdk-nfts";
import { type Result, err, ok } from "@parity/result";

import { accountIdHexToBytes } from "../identity/dotns.js";
import { isHex32 } from "./codec.js";
import { ProfileError } from "./errors.js";
import type {
    DroppedPin,
    PinnedNft,
    PinnedNftsResult,
    ProfileNft,
    ProfileNftsChain,
} from "./types.js";

const chainRead = (message: string, cause: unknown) =>
    new ProfileError("ChainRead", message, { cause });

/** The current owner of each instance in `chunk`, at the pinned block. The one read made here. */
async function readOwners(
    chain: ProfileNftsChain,
    chunk: ProfileNft[],
    snapshot: FinalizedSnapshot,
    signal: AbortSignal | undefined,
): Promise<Result<(string | undefined)[], ProfileError>> {
    try {
        return ok(
            await chain.assetHub.query.Scarcity.Instances.getValues(
                chunk.map((nft) => [nft.instance] as [bigint]),
                { at: snapshot.blockHash, signal },
            ),
        );
    } catch (cause) {
        return err(chainRead("Scarcity.Instances read failed", cause));
    }
}

/** One pin against what the chain said about its instance. */
function judge(
    nft: ProfileNft,
    display: InstanceDisplay | undefined,
    owner: string | undefined,
): PinnedNft | DroppedPin {
    if (display === undefined || display.tag === "NotFound" || owner === undefined) {
        return { nft, reason: "NotFound" };
    }
    if (display.collection !== nft.collection || display.item !== nft.item) {
        return { nft, reason: "Mismatch" };
    }
    if (!publicKeysEqual(accountIdBytes(owner), accountIdHexToBytes(nft.purse))) {
        return { nft, reason: "Moved" };
    }
    return { nft, display };
}

/**
 * The pins the chain confirms, with their displays, and the ones it does not.
 *
 * For every pin, the instance's current owner is read from
 * `Scarcity.Instances` and its display from `getInstanceDisplays`, at the same
 * finalized block, so a pin is confirmed only while the purse holds the
 * instance and the instance was minted from the collection and item the pin
 * names. A pin whose instance has moved, been burned, or never existed is
 * reported in `dropped` with the reason, never in `pins`.
 *
 * Lists longer than `MAX_INSTANCES_PER_READ` are read in chunks against the
 * block the first chunk pinned. Artwork is not fetched here: each display
 * carries its `imageRef`, for `getVerifiedArtwork` with `preimageSource`.
 *
 * A read the chain could not answer is a `ChainRead` {@link ProfileError}
 * carrying the underlying failure as `cause`, whether it came from the nfts
 * package's display read or from the owner read made here. The nfts package's
 * own error is on `cause` for a caller that wants to narrow on it.
 *
 * There is no re-pin. The block is pinned inside `getInstanceDisplays`, so a
 * block PAPI drops between the two reads surfaces as `ChainRead`, as it would
 * inside the nfts package itself; a retry belongs there, where the pin is
 * made, and this read would inherit it.
 *
 * A pin publicly ties the purse to the name. That was the owner's choice when
 * the pin was published; this read adds no linkage of its own.
 *
 * @example
 * ```ts
 * const pinned = await getPinnedNfts(chain, profile.nfts);
 * if (pinned.ok) {
 *     for (const { nft, display } of pinned.value.pins) {
 *         shelf.add(display.name ?? display.collectionName ?? `#${nft.instance}`);
 *     }
 * }
 * ```
 */
export async function getPinnedNfts(
    chain: ProfileNftsChain,
    nfts: ProfileNft[],
    options: PinnedReadOptions = {},
): Promise<Result<PinnedNftsResult, ProfileError>> {
    const bad = nfts.find((nft) => !isHex32(nft.purse));
    if (bad) {
        return err(new ProfileError("InvalidEntry", "a purse is a 32-byte account id as 0x hex"));
    }
    const pins: PinnedNft[] = [];
    const dropped: DroppedPin[] = [];

    const chunks: ProfileNft[][] = [];
    for (let i = 0; i < nfts.length; i += MAX_INSTANCES_PER_READ) {
        chunks.push(nfts.slice(i, i + MAX_INSTANCES_PER_READ));
    }
    // An empty list still pins a block, so `at` is always answered.
    if (chunks.length === 0) chunks.push([]);

    // The block first, with an empty read: joining a snapshot costs no round
    // trip, so every chunk's two reads can then go out together.
    const pinned = await getInstanceDisplays(chain, [], { at: options.at, signal: options.signal });
    if (!pinned.ok) return err(chainRead("instance display read failed", pinned.error));
    const snapshot = pinned.value.at;

    for (const chunk of chunks) {
        if (chunk.length === 0) continue;
        const [displays, owners] = await Promise.all([
            getInstanceDisplays(
                chain,
                chunk.map((nft) => nft.instance),
                { at: snapshot, signal: options.signal },
            ),
            readOwners(chain, chunk, snapshot, options.signal),
        ]);
        if (!displays.ok) return err(chainRead("instance display read failed", displays.error));
        if (!owners.ok) return owners;
        chunk.forEach((nft, i) => {
            const verdict = judge(nft, displays.value.displays[i], owners.value[i]);
            if ("reason" in verdict) dropped.push(verdict);
            else pins.push(verdict);
        });
    }

    return ok({ at: snapshot, pins, dropped });
}
