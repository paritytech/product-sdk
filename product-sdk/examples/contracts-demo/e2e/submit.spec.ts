// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers `contract.method.tx()` — the signed-transaction path in
 * `@parity/product-sdk-contracts`.
 *
 * `storeDailyReport(shopKey, date, cid, entryCount)` on the t3rminal
 * bulletin-index contract is permissionless (per the contract's NatSpec
 * `@dev Write is permissionless`). It exercises the full host-signing
 * path:
 *
 *   ContractManager → ReviveApi.call (dry-run) → Revive.call → submitAndWatch()
 *     → productAccount.getSigner() (host_create_transaction)
 *       → pallet_revive::call on Paseo Asset Hub
 *
 * Asserts:
 *   - The tx lands in a best block (result.ok = true).
 *   - Exactly one extrinsic was signed by the host signer (via the
 *     `"createTransaction"` path).
 *   - The button re-enables after completion.
 *
 * State isolation: this test writes to `SUBMIT_SHOP_KEY` (a fixed
 * non-zero sentinel), while `query.spec.ts` asserts against a freshly
 * randomised shopKey generated per test-run. The two specs use disjoint
 * keys because Paseo v2 is a public testnet — every successful submit
 * persists forever, and if both specs used the same key the submit's
 * write would pollute the query's "deterministic empty" assertions.
 */
const SUBMIT_SHOP_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

test.describe("@parity/product-sdk-contracts via Host API — submit", () => {
    test("storeDailyReport tx lands in best block via host signing", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        // Write under a fixed non-zero sentinel so this submit doesn't collide
        // with query.spec.ts's randomised shopKeys (see header for rationale).
        await frame.locator('[data-testid="query-shopkey-input"]').fill(SUBMIT_SHOP_KEY);

        const btn = frame.locator('[data-testid="btn-store-report"]');
        await btn.click();
        await expect(btn).toBeDisabled();

        const logLoc = frame.locator('[data-testid="contract-log"]');

        // The demo logs "storeDailyReport landed in block #N" on success
        await expect(logLoc).toContainText(/storeDailyReport landed in block #\d+/, {
            timeout: 90_000,
        });

        // Exactly one extrinsic was signed — no duplicate submissions
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(1);
        expect(signingLog[0].type).toBe("createTransaction");

        await expect(btn).toBeEnabled({ timeout: 10_000 });
    });
});
