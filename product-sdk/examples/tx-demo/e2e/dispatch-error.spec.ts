// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers `TxDispatchError` — a transaction that signs + submits + lands
 * in a block, but fails at dispatch. `Balances.force_set_balance` is
 * root-only; a non-root signer reaches dispatch cleanly and the runtime
 * rejects with `BadOrigin`.
 *
 * `submitAndWatch` surfaces this on the `err` channel of its `Result` as a
 * `TxDispatchError` carrying a formatted cause. The demo logs it as
 * "bad-tx dispatch error: TxDispatchError: ...".
 */
test.describe("@parity/product-sdk-tx via Host API — dispatch error", () => {
    test("root-only call surfaces TxDispatchError after block inclusion", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        const btn = frame.locator('[data-testid="btn-submit-bad-tx"]');
        await btn.click();
        await expect(btn).toBeDisabled();

        const logLoc = frame.locator('[data-testid="tx-log"]');

        // Proof the tx was actually signed + submitted (not blocked at
        // submission time): we see the `broadcasting` onStatus callback
        // fire. submitAndWatch does NOT emit `in-block` for a failing tx —
        // it settles with err(TxDispatchError) as soon as `event.ok === false`
        // is observed at best-block.
        await expect(logLoc).toContainText(/bad-tx: broadcasting/, { timeout: 90_000 });

        // The Result must then be err(TxDispatchError). The demo's else
        // branch names the error class; message format comes from
        // `formatDispatchError` and typically includes "BadOrigin".
        await expect(logLoc).toContainText(/bad-tx dispatch error:.*TxDispatchError/i, {
            timeout: 90_000,
        });
        // And onStatus("error") fires before the settle, giving us a
        // typed error surface to render.
        await expect(logLoc).toContainText(/bad-tx: error/, { timeout: 5_000 });

        // Exactly one signing call was recorded. The demo signs through
        // product-account routing (host_create_transaction), which the
        // test SDK records as type "createTransaction".
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(1);
        expect(signingLog[0].type).toBe("createTransaction");

        await expect(btn).toBeEnabled({ timeout: 10_000 });
    });
});
