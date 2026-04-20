import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * BYOD (bring-your-own-descriptors) chain connection tests.
 *
 * Verifies that:
 *   - createChainClient with custom descriptors/RPCs connects successfully.
 *   - BYOD bulletin RPC works (block number query returns > 0).
 *   - BYOD and preset connections are independent and can coexist.
 *
 * Host API surface tested:
 *   - createChainClient({ chains, rpcs }) -> direct WebSocket (bulletin not in host config)
 *   - Independent client instances don't interfere with each other
 */
test.describe("@polkadot-apps/chain-client via Host API — BYOD", () => {
    test("BYOD single-chain connection works", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // BYOD status should be connected
        await expect(frame.locator('[data-testid="byod-status"]')).toHaveText("connected");

        // Bulletin block number should be a number > 0
        const blockText = await frame
            .locator('[data-testid="byod-bulletin-block"]')
            .textContent();
        expect(blockText).toBeTruthy();
        const blockNumber = Number(blockText!.trim());
        expect(blockNumber).toBeGreaterThan(0);
    });

    test("BYOD and preset connections are independent", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Both should be connected
        await expect(frame.locator('[data-testid="preset-status"]')).toHaveText("connected");
        await expect(frame.locator('[data-testid="byod-status"]')).toHaveText("connected");

        // Both should show valid block numbers > 0
        const presetBlockText = await frame
            .locator('[data-testid="preset-asset-hub-block"]')
            .textContent();
        expect(presetBlockText).toBeTruthy();
        expect(Number(presetBlockText!.trim())).toBeGreaterThan(0);

        const byodBlockText = await frame
            .locator('[data-testid="byod-bulletin-block"]')
            .textContent();
        expect(byodBlockText).toBeTruthy();
        expect(Number(byodBlockText!.trim())).toBeGreaterThan(0);
    });
});
