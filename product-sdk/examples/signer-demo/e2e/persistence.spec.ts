import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

// SignerManager writes the selected account through `hostLocalStorage`,
// which the test SDK persists into the host page's `localStorage` under
// `test-host:${key}`. We poll for that key directly so we can reload only
// after the postMessage round-trip has actually flushed — avoiding a
// timing race where reload() races the persist write.
const STORAGE_KEY = "test-host:polkadot-apps:signer:signer-demo:selectedAccount";

test.describe("@polkadot-apps/signer — persistence", () => {
    test("selected account survives a page reload via hostLocalStorage", async ({
        testHost,
        page,
    }) => {
        const frame = await waitForAppReady(testHost);

        // Default selection is the first account (Bob). Pick the second row
        // (Charlie) explicitly so we can distinguish persistence from the
        // "just pick the first account" fallback after hydration.
        const rows = frame.locator('[data-testid="accounts-list"] .account-row');
        await expect(rows).toHaveCount(2);

        // Capture Bob's address (default selection) before clicking anything.
        const bobAddr = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(bobAddr).toBeTruthy();

        // Click Charlie's row. Wait for the selection to actually flip.
        await rows.nth(1).click();
        const selectedLoc = frame.locator('[data-testid="selected-address"]');
        await expect(selectedLoc).not.toHaveText(bobAddr!);
        const beforeReload = await selectedLoc.textContent();
        expect(beforeReload).toBeTruthy();
        expect(beforeReload).not.toBe(bobAddr);

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
