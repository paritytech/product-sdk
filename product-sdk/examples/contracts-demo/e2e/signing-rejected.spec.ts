// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers signing rejection in `@parity/product-sdk-contracts`.
 *
 * When the host denies the `TransactionSubmit` permission, `contract.tx()`
 * must reject with a `TxSigningRejectedError` (surfaced via `submitAndWatch`
 * inside `wrapContract`). The demo's catch block logs the error message.
 *
 * Mirrors the tx-demo signing-rejected spec — proves the rejection propagates
 * correctly through the contracts → tx → signer stack.
 */
test.describe("@parity/product-sdk-contracts via Host API — signing rejection", () => {
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
    test.skip("contract.tx() rejects cleanly when the host denies signing", async ({ testHost }) => {
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
