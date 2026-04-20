import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Smoke-test: the demo app boots cleanly through the Host API.
 *
 * Verifies that:
 *   - SignerManager.connect() succeeds via HostProvider (product-sdk).
 *   - StatementStoreClient.connect() picks HostTransport (not RPC fallback).
 *   - The selected account address is a Paseo SS58 address (prefix 0 → starts with "1").
 *
 * Host API surface tested:
 *   - getStatementStore() → HostTransport creation
 *   - store.subscribe() is called during connect (subscription setup)
 */
test.describe("@polkadot-apps/statement-store via Host API — boot", () => {
    test("app connects and StatementStoreClient initialises via Host API", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Account address should be a valid Paseo SS58 address (prefix 0 → starts with "1")
        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(SS58_PREFIX).toBe(0);
        expect(address!.trim().startsWith("1")).toBe(true);

        // Active provider should be the host (not a local dev provider)
        const provider = await frame.locator('[data-testid="active-provider"]').textContent();
        expect(provider?.trim()).not.toBe("-");

        // StatementStoreClient should be connected via HostTransport
        await expect(frame.locator('[data-testid="store-status"]')).toHaveText("connected");

        // Log should confirm host transport
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(
            /Statement store connected.*host transport/i,
        );
    });
});
