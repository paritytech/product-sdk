import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Smoke-test: the demo app boots cleanly through the Host API.
 *
 * Verifies that:
 *   - SignerManager.connect() succeeds via HostProvider (product-sdk).
 *   - createKvStore() auto-detects the host backend (not browser localStorage).
 *   - The selected account address is a Paseo SS58 address (prefix 0 → starts with "1").
 *
 * Host API surface tested:
 *   - isInsideContainer() → true
 *   - getHostLocalStorage() → host localStorage bridge
 */
test.describe("@polkadot-apps/storage via Host API — boot", () => {
    test("KvStore auto-detects host backend inside container", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Backend type should be "host" (auto-detected inside container)
        await expect(frame.locator('[data-testid="backend-type"]')).toHaveText("host");

        // Store status should be "ready"
        await expect(frame.locator('[data-testid="store-status"]')).toHaveText("ready");

        // Account address should be a valid Paseo SS58 address (prefix 0 → starts with "1")
        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(SS58_PREFIX).toBe(0);
        expect(address!.trim().startsWith("1")).toBe(true);

        // Log should confirm host backend
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /KvStore created.*host backend/i,
        );
    });
});
