// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * The `signal` option, which no button can carry — so this one drives the reads
 * directly through `window.__NFTS__` inside the product iframe.
 *
 * An aborted caller must land on the `err` channel rather than throw, and it
 * must do so before the pin costs a round trip.
 */
test.describe("@parity/product-sdk-nfts via Host API — cancellation", () => {
    test("an aborted signal lands on the err channel", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        const outcomes = await frame.locator("body").evaluate(async () => {
            const nfts = (window as unknown as Record<string, unknown>).__NFTS__ as {
                getCollections: (
                    chain: unknown,
                    options?: { signal?: AbortSignal },
                ) => Promise<{ ok: boolean }>;
                getCollectionItems: (
                    chain: unknown,
                    id: number,
                    options?: { signal?: AbortSignal },
                ) => Promise<{ ok: boolean }>;
                chain: unknown;
                MISSING_COLLECTION: number;
            };
            if (nfts.chain === null) return null;

            const controller = new AbortController();
            controller.abort();

            // Booleans, not the results: Playwright cannot serialize an Error.
            const registry = await nfts.getCollections(nfts.chain, {
                signal: controller.signal,
            });
            const catalogue = await nfts.getCollectionItems(nfts.chain, 0, {
                signal: controller.signal,
            });
            return { registry: registry.ok, catalogue: catalogue.ok };
        });

        expect(outcomes, "the demo should hold a connected chain client").not.toBeNull();
        expect(outcomes).toEqual({ registry: false, catalogue: false });
    });
});
