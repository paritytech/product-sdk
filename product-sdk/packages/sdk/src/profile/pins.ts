// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * NFT pins, checked against the chain. A pin says "this purse holds this
 * instance, minted from this collection and item"; the chain says whether that
 * is still so. The displays come from the nfts package, the owner from
 * `Scarcity.Instances`, both at one block.
 */
import { accountIdBytes } from "@parity/product-sdk-address";
import { hexToBytes } from "@parity/product-sdk-crypto";
import {
    type FinalizedSnapshot,
    type InstanceDisplay,
    MAX_INSTANCES_PER_READ,
    type PinnedReadOptions,
    type ProductNftsError,
    getInstanceDisplays,
} from "@parity/product-sdk-nfts";
import { type Result, err, ok } from "@parity/result";

import { ProfileError } from "./errors.js";
import type {
    DroppedPin,
    PinnedNft,
    PinnedNftsResult,
    ProfileNft,
    ProfileNftsChain,
} from "./types.js";

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
    return diff === 0;
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
    if (!sameBytes(accountIdBytes(owner), hexToBytes(nft.purse.slice(2)))) {
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
): Promise<Result<PinnedNftsResult, ProductNftsError | ProfileError>> {
    const pins: PinnedNft[] = [];
    const dropped: DroppedPin[] = [];
    let snapshot: FinalizedSnapshot | null = null;

    const chunks: ProfileNft[][] = [];
    for (let i = 0; i < nfts.length; i += MAX_INSTANCES_PER_READ) {
        chunks.push(nfts.slice(i, i + MAX_INSTANCES_PER_READ));
    }
    // An empty list still pins a block, so `at` is always answered.
    if (chunks.length === 0) chunks.push([]);

    for (const chunk of chunks) {
        const displays = await getInstanceDisplays(
            chain,
            chunk.map((nft) => nft.instance),
            { at: snapshot ?? options.at, signal: options.signal },
        );
        if (!displays.ok) return displays;
        snapshot ??= displays.value.at;
        if (chunk.length === 0) continue;

        try {
            const owners = await chain.assetHub.query.Scarcity.Instances.getValues(
                chunk.map((nft) => [nft.instance] as [bigint]),
                { at: snapshot.blockHash, signal: options.signal },
            );
            chunk.forEach((nft, i) => {
                const verdict = judge(nft, displays.value.displays[i], owners[i]);
                if ("reason" in verdict) dropped.push(verdict);
                else pins.push(verdict);
            });
        } catch (cause) {
            return err(new ProfileError("ChainRead", "Scarcity.Instances read failed", { cause }));
        }
    }

    return ok({ at: snapshot as FinalizedSnapshot, pins, dropped });
}
