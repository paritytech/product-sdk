// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Smoke-test: the chain-client demo boots cleanly through the Host API.
 *
 * Verifies that:
 *   - createChainClient connects asset hub via host provider.
 *   - Asset Hub RPC works (block number query returns > 0).
 *   - isConnected() reports true for asset hub.
 *   - The selected account address is a Paseo SS58 address (prefix 0 -> starts with "1").
 *   - Log shows connection confirmation.
 *
 * Host API surface tested:
 *   - chain-client provider routing via host genesis hash matching
 *   - createChainClient with BYOD descriptor/RPCs
 *   - isConnected(descriptor) -> synchronous cache lookup
 */
test.describe("@parity/product-sdk-chain-client via Host API — BYOD", () => {
    test("BYOD connects asset hub via host provider", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // BYOD status should be connected
        await expect(frame.locator('[data-testid="byod-status"]')).toHaveText("connected");

        // Asset Hub block number should be a number > 0 (proves RPC works)
        const blockText = await frame
            .locator('[data-testid="byod-asset-hub-block"]')
            .textContent();
        expect(blockText).toBeTruthy();
        const blockNumber = Number(blockText!.trim());
        expect(blockNumber).toBeGreaterThan(0);

        // isConnected should report true for asset hub
        await expect(frame.locator('[data-testid="byod-asset-hub-connected"]')).toHaveText("true");

        // Account address should be a valid Paseo SS58 address (prefix 0 -> starts with "1")
        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(SS58_PREFIX).toBe(0);
        expect(address!.trim().startsWith("1")).toBe(true);

        // Log should show connection confirmation
        await expect(frame.locator('[data-testid="chain-client-log"]')).toContainText(
            "BYOD connected",
        );
    });
});
