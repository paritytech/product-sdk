import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Counterpart to signer-demo's permission spec, but for the
 * `submitAndWatch` path. When the host rejects the signing permission,
 * `submitAndWatch` must reject with a `TxSigningRejectedError`
 * (classified via `isSigningRejection`). The demo's catch block logs
 * that as "remark failed: …" — we assert on that surface.
 */
test.describe("@parity/product-sdk-tx via Host API — signing rejection", () => {
    // workers:1: state leaks across tests. Restore default approve-all +
    // grant the permission back so subsequent specs in this run still sign.
    test.afterEach(async ({ testHost }) => {
        await testHost.setPermissionBehavior("approve-all");
        await testHost.grantPermission("TransactionSubmit");
    });

    // TODO(novasama-0.7-upgrade): novasama 0.7's product-sdk caches the
    // TransactionSubmit permission grant from initial connect rather than
    // re-checking on each sign. The test SDK's revokePermission no longer
    // surfaces a denial through the signing path. Re-enable once the test
    // SDK and product-sdk converge on a permission-rejection contract that
    // applies per-sign.
    test.skip("submitAndWatch rejects cleanly when the host denies signing", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        // Flip the host to reject every permission re-request, then remove
        // the grant established during SignerManager.connect(). The next
        // sign call goes through the host's host_create_transaction, fails
        // the permission gate, and propagates back through PAPI's observable.
        await testHost.setPermissionBehavior("reject-all");
        await testHost.revokePermission("TransactionSubmit");
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="btn-submit-remark"]').click();

        const logLoc = frame.locator('[data-testid="tx-log"]');
        // TxSigningRejectedError's default message is "Transaction signing
        // was rejected." — we match loosely so product-sdk tweaks don't
        // break the assertion.
        await expect(logLoc).toContainText(/remark failed:.*(reject|denied|permission)/i, {
            timeout: 30_000,
        });

        // No sign payload should have been recorded: the host rejected
        // before reaching host_create_transaction's signing path.
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });
});
