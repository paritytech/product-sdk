// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Client lifecycle tests — destroy and connection cleanup.
 *
 * Verifies that:
 *   - destroy() + destroyAll() tears down connections.
 *   - isConnected() returns false for asset hub after destruction.
 *   - UI reflects the destroyed state.
 *   - Log captures the lifecycle event.
 *
 * Host API surface tested:
 *   - ChainClient.destroy() -> tears down individual client
 *   - destroyAll() -> clears cache
 *   - isConnected(descriptor) -> returns false after cache cleared
 */
test.describe("@parity/product-sdk-chain-client via Host API — lifecycle", () => {
    test("destroy cleans up client connections", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Verify connected state
        await expect(frame.locator('[data-testid="byod-status"]')).toHaveText("connected");
        await expect(frame.locator('[data-testid="byod-asset-hub-connected"]')).toHaveText("true");

        // Click destroy button
        await frame.locator('[data-testid="btn-destroy"]').click();

        // Wait for status to become "destroyed"
        await expect(frame.locator('[data-testid="byod-status"]')).toHaveText("destroyed", {
            timeout: 30_000,
        });

        // isConnected should report false for asset hub
        await expect(frame.locator('[data-testid="byod-asset-hub-connected"]')).toHaveText("false");

        // Log should capture the destruction event
        await expect(frame.locator('[data-testid="chain-client-log"]')).toContainText("destroyed");
    });
});
