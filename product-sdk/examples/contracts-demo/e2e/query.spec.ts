import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers `contract.method.query()` — the dry-run (read-only) path in
 * `@polkadot-apps/contracts`.
 *
 * `owner()` on the t3rminal bulletin-index contract is a zero-arg view
 * function that returns the deployer's H160 address. It exercises:
 *   - The full RPC path through the host's chainConnection handler.
 *   - `ContractManager.getContract().owner.query()` resolution.
 *   - No signing is involved — proves queries work independently.
 *
 * The owner address is stable (deployer set at construction), so the
 * assertion is a simple non-null, non-error check.
 */
test.describe("@polkadot-apps/contracts via Host API — query", () => {
    test("owner() dry-run returns a hex address without signing", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="btn-query-owner"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');

        // The result is an H160 address (0x...)
        await expect(logLoc).toContainText(/owner: 0x[0-9a-fA-F]{40}/i, { timeout: 30_000 });

        // No signing should have occurred — query is a pure dry-run
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });
});
