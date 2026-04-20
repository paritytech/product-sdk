import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Smoke-test: the demo app boots and resolves host strategies.
 *
 * Verifies that:
 *   - SignerManager.connect() succeeds via HostProvider.
 *   - resolveUploadStrategy() returns "preimage" (host path).
 *   - resolveQueryStrategy() returns "host-lookup" (host path).
 *   - BulletinClient initializes via BYOD chain client.
 *
 * Host API surface tested:
 *   - isInsideContainer() → true (triggers host strategies)
 *   - resolveUploadStrategy() → preimage kind
 *   - resolveQueryStrategy() → host-lookup kind
 */
test.describe("@polkadot-apps/bulletin via Host API — boot", () => {
    test("app connects and resolves host strategies", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Account address is valid Paseo SS58 (prefix 0 → starts with "1")
        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(SS58_PREFIX).toBe(0);
        expect(address!.trim().startsWith("1")).toBe(true);

        // Active provider is the host
        const provider = await frame.locator('[data-testid="active-provider"]').textContent();
        expect(provider?.trim()).not.toBe("-");

        // Upload strategy is "preimage" (host path)
        await expect(frame.locator('[data-testid="upload-strategy"]')).toHaveText("preimage");

        // Query strategy is "host-lookup" (host path)
        await expect(frame.locator('[data-testid="query-strategy"]')).toHaveText("host-lookup");

        // BulletinClient connected
        await expect(frame.locator('[data-testid="bulletin-status"]')).toHaveText("connected");

        // Log should confirm strategies
        await expect(frame.locator('[data-testid="bulletin-log"]')).toContainText(
            /Upload strategy: preimage/i,
        );
        await expect(frame.locator('[data-testid="bulletin-log"]')).toContainText(
            /Query strategy: host-lookup/i,
        );
    });
});
