// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

// SignerManager writes the selected account through `hostLocalStorage`. In
// test-sdk 0.14.0 the host core is WebAssembly-backed and namespaces product
// storage per product, so it no longer lands in the host page's raw
// `localStorage` under a `test-host:` prefix — there is no such prefix any
// more. The replacement is `getProductStorage()`, which returns every
// product-storage entry decoded as UTF-8, keyed by the core's internal
// namespaced key (confirmed by probe: `truapi:product-storage:v1:<n>:<productId>:<key>`,
// where `<n>` is `productId.length`). We match on the suffix rather than
// hardcoding that internal prefix scheme, since only the local key
// (`product-sdk:signer:signer-demo:selectedAccount`) is part of the
// documented contract. We poll it directly so we can reload only after the
// postMessage round-trip has actually flushed — avoiding a timing race where
// reload() races the persist write.
const STORAGE_KEY_SUFFIX = ":product-sdk:signer:signer-demo:selectedAccount";

test.describe("@parity/product-sdk-signer — persistence", () => {
    test("selected account survives a page reload via hostLocalStorage", async ({
        testHost,
        page,
    }) => {
        const frame = await waitForAppReady(testHost);

        // The host connect path surfaces a single derived product account,
        // which is auto-selected on connect. (We can no longer distinguish
        // persistence from the "pick first" fallback by selecting a second
        // account — enumeration is gone — but the storage round-trip below
        // still proves the selection is persisted and re-hydrated on reload.)
        const rows = frame.locator('[data-testid="accounts-list"] .account-row');
        await expect(rows).toHaveCount(1);

        // Capture the selected (product) account, then re-select it so the
        // persistence write fires deterministically.
        const selectedLoc = frame.locator('[data-testid="selected-address"]');
        await rows.nth(0).click();
        const beforeReload = await selectedLoc.textContent();
        expect(beforeReload).toBeTruthy();

        // Wait for SignerManager.persistAccount to flush through the
        // postMessage round-trip into host storage. Without this we race
        // reload() against the async write — passes alone, fails when run
        // after other specs that warm up the test runner.
        await page.waitForFunction(
            ({ suffix, addr }) => {
                const storage = window.__TEST_HOST__.getProductStorage();
                return Object.entries(storage).some(
                    ([key, value]) => key.endsWith(suffix) && value === addr,
                );
            },
            { suffix: STORAGE_KEY_SUFFIX, addr: beforeReload },
            { timeout: 10_000 },
        );

        // Full page reload: browser drops the iframe + container, rebuilds
        // everything from scratch. SignerManager.connect() re-runs and its
        // persistence layer should hydrate the previously-selected account
        // from hostLocalStorage (which the test SDK backs with real
        // browser localStorage, so it survives the reload).
        await testHost.page.reload();

        const reloadedFrame = await waitForAppReady(testHost);
        const afterReload = await reloadedFrame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(afterReload).toBe(beforeReload);
    });
});
