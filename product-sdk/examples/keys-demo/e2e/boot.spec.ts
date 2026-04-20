import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Smoke-test: the demo app boots cleanly through the Host API.
 *
 * Verifies that:
 *   - SignerManager.connect() succeeds via HostProvider (product-sdk).
 *   - SessionKeyManager initialises with host-backed storage.
 *   - The selected account address is a Paseo SS58 address (prefix 0 -> starts with "1").
 *
 * Host API surface tested:
 *   - isInsideContainer() -> product-sdk sandbox detection
 *   - createKvStore() -> host-backed KvStore via product-sdk hostLocalStorage
 *   - SessionKeyManager({ store }) -> ready state
 */
test.describe("@polkadot-apps/keys via Host API — boot", () => {
    test("SessionKeyManager initialises with host-backed storage", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Storage backend should be "host" inside the test host
        await expect(frame.locator('[data-testid="storage-backend"]')).toHaveText("host");

        // Session status should be "ready"
        await expect(frame.locator('[data-testid="session-status"]')).toHaveText("ready");

        // Account address should be a valid Paseo SS58 address (prefix 0 -> starts with "1")
        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(SS58_PREFIX).toBe(0);
        expect(address!.trim().startsWith("1")).toBe(true);
    });
});
