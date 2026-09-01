// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { numberIn, waitForAppReady } from "./helpers";

/**
 * The three reads in `@parity/product-sdk-nfts`, against live Paseo Next Asset
 * Hub through the Host API.
 *
 * Live state decides the counts, so the assertions are about shape: a registry
 * pinned to one block and ascending by id, a catalogue that resolves `Found`,
 * an `ImageRef` carrying hex whatever the deployment stores, and a collection
 * nobody created arriving on the ok channel.
 *
 * **One boot covers the whole first read.** Every field below comes from the
 * same `init()`, so splitting them across tests would reconnect the host and
 * the RPC once per assertion — which is both slow and how a public endpoint
 * starts refusing connections mid-run.
 *
 * SDK surface tested:
 *   - getClaimableCollections -> Scarcity.NextCollectionId + NftClaims.CollectionMinters +
 *                              Scarcity.Collections/CollectionMetadata
 *   - getCollections       -> Scarcity.NextCollectionId + an exact-key window, annotated from
 *                              the registry. Every read here is paged; `limit` defaults rather
 *                              than meaning "everything"
 *   - getCollections paged -> a small-page walk pinned with `at`, cross-checked against a
 *                              single larger page
 *   - getCollectionItems      -> Scarcity.ItemDefs/ItemMetadata prefix scans, merged metadata
 *   - the structural chain contract, satisfied by a real ChainClient
 */
test.describe("@parity/product-sdk-nfts via Host API — catalogue reads", () => {
    test("the registry, a catalogue and a clean miss all read at one pinned block", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        // -- getClaimableCollections ------------------------------------------------
        // Every value in one result comes from the same finalized block.
        expect(await numberIn(frame, "registry-block")).toBeGreaterThan(0);

        // `Scarcity` and `NftClaims` are live on this chain, and at least one
        // collection accepts claims. A zero here means the network changed, not
        // that the read is broken.
        const count = await numberIn(frame, "registry-count");
        expect(count).toBeGreaterThan(0);

        // The id-window walk visits the space in order, so ids arrive ascending
        // by construction — this pins that as a contract.
        const idsText = await frame.locator('[data-testid="registry-ids"]').textContent();
        const ids = idsText!
            .trim()
            .split(",")
            .map((id) => Number(id));
        expect(ids).toHaveLength(count);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        await expect(frame.locator('[data-testid="nfts-log"]')).toContainText("registered at #");

        // -- getCollections ---------------------------------------------
        // Its own pinned block: two reads are two snapshots.
        expect(await numberIn(frame, "all-block")).toBeGreaterThan(0);

        const allIdsText = await frame.locator('[data-testid="all-ids"]').textContent();
        const allIds = allIdsText!
            .trim()
            .split(",")
            .map((id) => Number(id));
        expect(allIds).toEqual([...allIds].sort((a, b) => a - b));
        expect(allIds).toHaveLength(await numberIn(frame, "all-count"));

        // The relationship that holds whatever this chain currently carries:
        // an id this read flags claimable came from `CollectionMinters`, so the
        // registry above must also name it. Asserted in this direction only —
        // the reverse can fail legitimately, when a minter entry outlives its
        // `Scarcity.Collections` record and so cannot appear here at all.
        const claimableHere = await numberIn(frame, "all-claimable-count");
        expect(claimableHere).toBeLessThanOrEqual(count);

        // `selection: null` is the "exists but accepts no claims" signal, and
        // the two counts have to add up to the whole list.
        const unclaimableText = (await frame
            .locator('[data-testid="all-unclaimable-ids"]')
            .textContent())!.trim();
        const unclaimableIds =
            unclaimableText === "(none)" ? [] : unclaimableText.split(",").map(Number);
        expect(claimableHere + unclaimableIds.length).toBe(allIds.length);
        for (const id of unclaimableIds) expect(allIds).toContain(id);
        await expect(frame.locator('[data-testid="nfts-log"]')).toContainText("accepting no claims");

        // -- getCollections, paged by id window ----------------------------
        // The id space is bounded by `NextCollectionId`, which is exclusive, so
        // it is at least as large as the highest live id plus one.
        const ceiling = await numberIn(frame, "all-id-ceiling");
        expect(ceiling).toBeGreaterThanOrEqual(allIds.length);
        expect(ceiling).toBeGreaterThan(Math.max(...allIds));

        // Several pages at limit 2, so `nextId` is actually followed rather than
        // the whole chain arriving in one window.
        expect(await numberIn(frame, "paged-pages")).toBeGreaterThan(1);

        const pagedIdsText = await frame.locator('[data-testid="paged-ids"]').textContent();
        const pagedIds = pagedIdsText!
            .trim()
            .split(",")
            .map((id) => Number(id));
        // Paging must find exactly what the single page found, in the same order.
        expect(pagedIds).toEqual(allIds);

        // A walk in pages of two sees exactly what one page big enough for the
        // whole chain sees — same ids, same name for each — so `fromId` / `nextId`
        // are stepping the id space rather than skipping or repeating.
        await expect(frame.locator('[data-testid="paged-agrees"]')).toHaveText("yes");

        // The walk passed `at`, so every page read at one block however many
        // blocks the chain produced while it ran.
        expect(await numberIn(frame, "paged-blocks")).toBe(1);

        // -- getCollectionItems, on the first registered collection --------
        await expect(frame.locator('[data-testid="catalogue-tag"]')).toHaveText("Found");
        expect(await numberIn(frame, "collection-id")).toBeGreaterThanOrEqual(0);
        const items = await numberIn(frame, "catalogue-item-count");
        expect(items).toBeGreaterThanOrEqual(0);

        // Random or Contract — anything else is a decode error, never a passthrough.
        const selection = await frame.locator('[data-testid="collection-selection"]').textContent();
        expect(["Random", "Contract"]).toContain(selection!.trim());

        if (items > 0) {
            // `liveSupply` is `supply` less the instances burned, so it never exceeds it.
            const supply = await frame.locator('[data-testid="item-supply"]').textContent();
            const [live, total] = supply!.trim().split("/").map(Number);
            expect(Number.isFinite(live) && Number.isFinite(total)).toBe(true);
            expect(live).toBeLessThanOrEqual(total);

            // An item's `image` is optional, but when set the hex reading is
            // always there — that is the half of `ImageRef` a caller can rely on.
            const hex = (await frame
                .locator('[data-testid="item-image-hex"]')
                .textContent())!.trim();
            if (hex !== "-") expect(hex.startsWith("0x")).toBe(true);
        }

        // -- the miss ------------------------------------------------------
        // u32 max: the chain was asked and answered, so this rides the ok channel.
        await expect(frame.locator('[data-testid="missing-tag"]')).toHaveText("NotFound");
    });

    test("re-reading on the same client pins a fresh block and reports no failure", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        await frame.locator('[data-testid="btn-refresh"]').click();
        await expect(frame.locator('[data-testid="nfts-log"]')).toContainText("Re-reading");
        await expect(frame.locator('[data-testid="btn-refresh"]')).toBeEnabled({
            timeout: 60_000,
        });

        expect(await numberIn(frame, "registry-block")).toBeGreaterThan(0);
        await expect(frame.locator('[data-testid="nfts-log"]')).not.toContainText("failed");
    });
});
