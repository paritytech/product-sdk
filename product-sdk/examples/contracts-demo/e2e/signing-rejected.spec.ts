import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers signing rejection in `@polkadot-apps/contracts`.
 *
 * When the host denies the `TransactionSubmit` permission, `contract.tx()`
 * must reject with a `TxSigningRejectedError` (surfaced via `submitAndWatch`
 * inside `wrapContract`). The demo's catch block logs the error message.
 *
 * Mirrors the tx-demo signing-rejected spec — proves the rejection propagates
 * correctly through the contracts → tx → signer stack.
 */
test.describe("@polkadot-apps/contracts via Host API — signing rejection", () => {
    test.afterEach(async ({ testHost }) => {
        await testHost.setPermissionBehavior("approve-all");
        await testHost.grantPermission("TransactionSubmit");
    });

    test("contract.tx() rejects cleanly when the host denies signing", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        await testHost.setPermissionBehavior("reject-all");
        await testHost.revokePermission("TransactionSubmit");
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="btn-store-report"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');
        await expect(logLoc).toContainText(/storeDailyReport failed:.*(reject|denied|permission)/i, {
            timeout: 30_000,
        });

        // No payload was signed — host rejected before reaching the keyring
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });
});
