// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

// The host core namespaces product storage internally; getProductStorageValue()
// resolves this local key against it.
const STORAGE_LOCAL_KEY = "product-sdk:signer:signer-demo:selectedAccount";

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
        // Wait out the postMessage round-trip; otherwise reload() races the
        // write — passes alone, fails after specs that warm the runner.
        await page.waitForFunction(
            ({ localKey, addr }) => window.__TEST_HOST__.getProductStorageValue(localKey) === addr,
            { localKey: STORAGE_LOCAL_KEY, addr: beforeReload },
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
