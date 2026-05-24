import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers `contract.method.tx()` — the signed-transaction path in
 * `@parity/product-sdk-contracts`.
 *
 * `storeDailyReport(date, cid, entryCount)` on the t3rminal bulletin-index
 * contract is permissionless: any caller stores a report indexed by
 * msg.sender. It exercises the full host-signing path:
 *
 *   ContractManager → ReviveApi.call (dry-run) → Revive.call → submitAndWatch()
 *     → host.handleCreateTransaction (ChainSubmit permission)
 *       → pallet_revive::call on Paseo Asset Hub
 *
 * Asserts:
 *   - The tx lands in a best block (result.ok = true).
 *   - Exactly one transaction was signed by the host signer.
 *   - The button re-enables after completion.
 */
// TODO(contract-redeploy): Unskip once `@t3rminal/bulletin-index` is
// redeployed on paseo v2 and `examples/contracts-demo/src/cdm.json` is
// updated with the new address. AsPgas-on-Paseo-v2 signing was the other
// blocker, now resolved by pinning host signing to "createTransaction"
// (see `PRODUCT_SIGNER_TYPE` in `packages/signer/src/providers/host.ts`).
test.describe.skip("@parity/product-sdk-contracts via Host API — submit", () => {
    test("storeDailyReport tx lands in best block via host signing", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        const btn = frame.locator('[data-testid="btn-store-report"]');
        await btn.click();
        await expect(btn).toBeDisabled();

        const logLoc = frame.locator('[data-testid="contract-log"]');

        // The demo logs "storeDailyReport landed in block #N" on success
        await expect(logLoc).toContainText(/storeDailyReport landed in block #\d+/, {
            timeout: 90_000,
        });

        // Exactly one extrinsic was signed — no duplicate submissions. Host
        // signer is pinned to "createTransaction" (see `PRODUCT_SIGNER_TYPE`
        // in `packages/signer/src/providers/host.ts`).
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(1);
        expect(signingLog[0].type).toBe("createTransaction");

        await expect(btn).toBeEnabled({ timeout: 10_000 });
    });
});
