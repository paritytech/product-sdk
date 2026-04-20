import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Client lifecycle tests — destroy and connection cleanup.
 *
 * Verifies that:
 *   - destroy() + destroyAll() tears down connections.
 *   - isConnected() returns false for all chains after destruction.
 *   - UI reflects the destroyed state.
 *   - Log captures the lifecycle event.
 *
 * Host API surface tested:
 *   - ChainClient.destroy() -> tears down individual client
 *   - destroyAll() -> clears cache + resets smoldot
 *   - isConnected(descriptor) -> returns false after cache cleared
 */
test.describe("@polkadot-apps/chain-client via Host API — lifecycle", () => {
    test("destroy cleans up client connections", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Click destroy button
        await frame.locator('[data-testid="btn-destroy-preset"]').click();

        // Wait for preset status to become "destroyed"
        await expect(frame.locator('[data-testid="preset-status"]')).toHaveText("destroyed", {
            timeout: 30_000,
        });

        // isConnected should report false for bulletin and individuality
        await expect(frame.locator('[data-testid="preset-bulletin-connected"]')).toHaveText(
            "false",
        );
        await expect(frame.locator('[data-testid="preset-individuality-connected"]')).toHaveText(
            "false",
        );

        // Log should capture the destruction event
        await expect(frame.locator('[data-testid="chain-client-log"]')).toContainText("destroyed");
    });
});
