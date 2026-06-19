// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

// SignerManager writes the selected account through `hostLocalStorage`,
// which the test SDK persists into the host page's `localStorage` under
// `test-host:${key}`. We poll for that key directly so we can reload only
// after the postMessage round-trip has actually flushed — avoiding a
// timing race where reload() races the persist write.
const STORAGE_KEY = "test-host:product-sdk:signer:signer-demo:selectedAccount";

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
        // postMessage round-trip into host localStorage. Without this we
        // race reload() against the async write — passes alone, fails when
        // run after other specs that warm up the test runner.
        await page.waitForFunction(
            ({ key, addr }) => window.localStorage.getItem(key) === addr,
            { key: STORAGE_KEY, addr: beforeReload },
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
