import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Smoke-test: the chain-client demo boots cleanly through the Host API.
 *
 * Verifies that:
 *   - getChainAPI("paseo") connects all three chains (assetHub, bulletin, individuality).
 *   - Asset Hub RPC works (block number query returns > 0).
 *   - isConnected() reports true for bulletin and individuality.
 *   - The selected account address is a Paseo SS58 address (prefix 0 -> starts with "1").
 *   - Log shows connection confirmation.
 *
 * Host API surface tested:
 *   - chain-client provider routing via host genesis hash matching
 *   - getChainAPI("paseo") -> createChainClient with preset descriptors/RPCs
 *   - isConnected(descriptor) -> synchronous cache lookup
 */
test.describe("@polkadot-apps/chain-client via Host API — preset", () => {
    test("preset connects all chains via host provider", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Preset status should be connected
        await expect(frame.locator('[data-testid="preset-status"]')).toHaveText("connected");

        // Asset Hub block number should be a number > 0 (proves RPC works)
        const blockText = await frame
            .locator('[data-testid="preset-asset-hub-block"]')
            .textContent();
        expect(blockText).toBeTruthy();
        const blockNumber = Number(blockText!.trim());
        expect(blockNumber).toBeGreaterThan(0);

        // isConnected should report true for bulletin and individuality
        await expect(frame.locator('[data-testid="preset-bulletin-connected"]')).toHaveText("true");
        await expect(frame.locator('[data-testid="preset-individuality-connected"]')).toHaveText(
            "true",
        );

        // Account address should be a valid Paseo SS58 address (prefix 0 -> starts with "1")
        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(SS58_PREFIX).toBe(0);
        expect(address!.trim().startsWith("1")).toBe(true);

        // Log should show connection confirmation
        await expect(frame.locator('[data-testid="chain-client-log"]')).toContainText(
            "Preset connected",
        );
    });
});
