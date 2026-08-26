// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point for the @parity/product-sdk-nfts E2E demo.
 *
 * Both reads are pure catalogue, so there is no signer here: they need a chain
 * client and nothing else. The client comes from the host over the container's
 * chain API, the same path the other demos take.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. createChainClient({ chains: { assetHub } }) connects via the host
 *   2. getCollections(chain) -> the claim registry, ascending by id
 *   3. getCollectionItems(chain, id) -> that collection's catalogue
 *   4. getCollectionItems(chain, MISSING_COLLECTION) -> `NotFound` on the ok
 *      channel, which is the part of the contract worth seeing in a UI
 *
 * Live chain state decides what steps 2 and 3 report, so the Playwright suite
 * asserts shapes — a sorted registry, a `Found` catalogue, an `ImageRef`
 * carrying hex — rather than counts a chain write would break.
 */

import { createChainClient } from "@parity/product-sdk-chain-client";
import type { ChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { getCollectionItems, getCollections, NftsChainEntryError } from "@parity/product-sdk-nfts";

import { appendLog, getEl } from "./ui.js";

// -- DOM ------------------------------------------------------------------
const $chainStatus = getEl<HTMLSpanElement>("chain-status");
const $registryBlock = getEl<HTMLSpanElement>("registry-block");
const $registryCount = getEl<HTMLSpanElement>("registry-count");
const $registryIds = getEl<HTMLSpanElement>("registry-ids");
const $collectionId = getEl<HTMLSpanElement>("collection-id");
const $collectionName = getEl<HTMLSpanElement>("collection-name");
const $collectionSelection = getEl<HTMLSpanElement>("collection-selection");
const $catalogueTag = getEl<HTMLSpanElement>("catalogue-tag");
const $catalogueItemCount = getEl<HTMLSpanElement>("catalogue-item-count");
const $itemName = getEl<HTMLSpanElement>("item-name");
const $itemSupply = getEl<HTMLSpanElement>("item-supply");
const $itemImageHex = getEl<HTMLSpanElement>("item-image-hex");
const $itemImageText = getEl<HTMLSpanElement>("item-image-text");
const $missingTag = getEl<HTMLSpanElement>("missing-tag");
const $btnRefresh = getEl<HTMLButtonElement>("btn-refresh");
const $log = getEl<HTMLElement>("nfts-log");

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

/** No `Scarcity.Collections` record can exist at u32 max, so this is always a miss. */
const MISSING_COLLECTION = 4_294_967_295;

let chain: ChainClient<{ assetHub: typeof paseo_asset_hub }> | null = null;

/**
 * `NftsChainEntryError` is the one failure worth reporting by class: it means
 * the client cannot read an entry the package needs — a descriptor whitelist
 * missing an entry, or a chain without the pallets — and no retry will fix it.
 */
function describeError(error: unknown): string {
    if (error instanceof NftsChainEntryError) {
        return `${error.name}(${error.entry ?? "entry unknown"}): ${error.message}`;
    }
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function readCatalogue(id: number): Promise<void> {
    if (!chain) return;
    const catalogue = await getCollectionItems(chain, id);
    if (!catalogue.ok) {
        $catalogueTag.textContent = "error";
        log(`getCollectionItems(${id}) failed: ${describeError(catalogue.error)}`, "err");
        return;
    }

    $catalogueTag.textContent = catalogue.value.tag;
    if (catalogue.value.tag === "NotFound") {
        log(`getCollectionItems(${id}): NotFound — a clean miss, not an error`, "ok");
        return;
    }

    const { collection } = catalogue.value;
    $catalogueItemCount.textContent = String(collection.items.length);
    log(`getCollectionItems(${id}): ${collection.items.length} items`, "ok");

    const item = collection.items[0];
    if (!item) return;
    $itemName.textContent = item.name ?? "(unnamed)";
    $itemSupply.textContent = `${item.liveSupply}/${item.supply}`;
    // Both readings of the same bytes: deployments disagree over whether
    // `image` holds a content digest or an ASCII CID.
    $itemImageHex.textContent = item.imageRef?.hex ?? "-";
    $itemImageText.textContent = item.imageRef?.text ?? "-";
}

async function read(): Promise<void> {
    if (!chain) return;
    $btnRefresh.disabled = true;

    try {
        const registry = await getCollections(chain);
        if (!registry.ok) {
            $registryCount.textContent = "error";
            log(`getCollections failed: ${describeError(registry.error)}`, "err");
            return;
        }

        const { at, collections } = registry.value;
        $registryBlock.textContent = String(at.blockNumber);
        $registryCount.textContent = String(collections.length);
        $registryIds.textContent = collections.map((c) => c.id).join(",") || "-";
        log(`getCollections: ${collections.length} registered at #${at.blockNumber}`, "ok");

        const first = collections[0];
        if (first === undefined) {
            log("No collection accepts claims on this chain — nothing to catalogue", "info");
            return;
        }
        $collectionId.textContent = String(first.id);
        $collectionName.textContent = first.name ?? "(unnamed)";
        $collectionSelection.textContent = first.selection.tag;

        await readCatalogue(first.id);

        // The miss is a success value, and reading it is the only way to see that.
        const missing = await getCollectionItems(chain, MISSING_COLLECTION);
        $missingTag.textContent = missing.ok ? missing.value.tag : "error";
    } finally {
        $btnRefresh.disabled = false;
    }
}

$btnRefresh.addEventListener("click", () => {
    log("Re-reading at a fresh block...");
    void read();
});

// -- Boot -----------------------------------------------------------------
async function init(): Promise<void> {
    log("Booting nfts-demo...");

    try {
        chain = await createChainClient({ chains: { assetHub: paseo_asset_hub } });
        $chainStatus.textContent = "connected";
        log("Chain client connected via the host", "ok");
    } catch (err) {
        $chainStatus.textContent = "error";
        log(`Chain connection failed: ${(err as Error).message}`, "err");
        return;
    }

    await read();
    log("Ready", "ok");
}

// Exposed so the suite can drive the reads directly — the cancellation spec
// needs an AbortSignal, which no button can carry.
declare global {
    interface Window {
        __NFTS__: {
            getCollections: typeof getCollections;
            getCollectionItems: typeof getCollectionItems;
            readonly chain: ChainClient<{ assetHub: typeof paseo_asset_hub }> | null;
            MISSING_COLLECTION: number;
        };
    }
}

window.__NFTS__ = {
    getCollections,
    getCollectionItems,
    get chain() {
        return chain;
    },
    MISSING_COLLECTION,
};

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
