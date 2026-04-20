import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Smoke-test: the demo app boots cleanly through the Host API.
 *
 * Verifies that:
 *   - SignerManager.connect() succeeds via HostProvider (product-sdk).
 *   - isInsideContainer() returns true inside the test host.
 *   - isInsideContainerSync() returns true (iframe heuristic).
 *   - getHostLocalStorage() returns an available instance.
 *   - The selected account address is a Paseo SS58 address (prefix 0 -> starts with "1").
 *
 * Host API surface tested:
 *   - isInsideContainer() -> product-sdk sandbox detection
 *   - isInsideContainerSync() -> iframe/webview heuristic
 *   - getHostLocalStorage() -> product-sdk hostLocalStorage
 */
test.describe("@polkadot-apps/host via Host API — boot", () => {
    test("container detection and host storage initialise via Host API", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Container detection (async) should report true inside the test host
        await expect(frame.locator('[data-testid="container-status"]')).toHaveText("true");

        // Container detection (sync) should also report true (iframe heuristic)
        await expect(frame.locator('[data-testid="container-sync-status"]')).toHaveText("true");

        // Host storage should be available
        await expect(frame.locator('[data-testid="host-storage-status"]')).toHaveText("available");

        // Account address should be a valid Paseo SS58 address (prefix 0 -> starts with "1")
        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(SS58_PREFIX).toBe(0);
        expect(address!.trim().startsWith("1")).toBe(true);

        // Active provider should be the host (not a local dev provider)
        const provider = await frame.locator('[data-testid="active-provider"]').textContent();
        expect(provider?.trim()).not.toBe("-");
    });
});
