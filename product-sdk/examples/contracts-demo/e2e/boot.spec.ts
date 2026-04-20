import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Smoke-test: the demo app boots cleanly through the Host API.
 *
 * Verifies that:
 *   - SignerManager.connect() succeeds via HostProvider (not a dev fallback).
 *   - getChainAPI("paseo") connects through the host's chainConnection handler.
 *   - ContractManager.fromClient() initialises successfully.
 *   - The selected account address is a Paseo SS58 address (prefix 0 → starts with "1").
 */
test.describe("@polkadot-apps/contracts via Host API — boot", () => {
    test("app connects and ContractManager initialises via Host API", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        // Paseo Asset Hub uses SS58 prefix 0 — addresses start with "1"
        expect(SS58_PREFIX).toBe(0);
        expect(address!.trim().startsWith("1")).toBe(true);

        // Active provider should be the host (not a local dev provider)
        const provider = await frame.locator('[data-testid="active-provider"]').textContent();
        expect(provider?.trim()).not.toBe("-");

        // Log should confirm ContractManager is ready
        await expect(frame.locator('[data-testid="contract-log"]')).toContainText(
            /ContractManager ready/i,
        );
    });
});
