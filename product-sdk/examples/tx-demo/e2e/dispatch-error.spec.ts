import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers `TxDispatchError` — a transaction that signs + submits + lands
 * in a block, but fails at dispatch. `Balances.force_set_balance` is
 * root-only; a non-root signer reaches dispatch cleanly and the runtime
 * rejects with `BadOrigin`.
 *
 * `submitAndWatch` surfaces this by rejecting the promise with
 * `TxDispatchError` carrying a formatted cause. The demo's catch block
 * logs it as "bad-tx rejected: TxDispatchError: ...".
 */
test.describe("@polkadot-apps/tx via Host API — dispatch error", () => {
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
        // see submit.ts:118-128, it exits early with TxDispatchError as
        // soon as `event.ok === false` is observed at best-block.
        await expect(logLoc).toContainText(/bad-tx: broadcasting/, { timeout: 90_000 });

        // The promise must then reject with TxDispatchError. The demo's
        // catch block names the error class; message format comes from
        // `formatDispatchError` and typically includes "BadOrigin".
        await expect(logLoc).toContainText(/bad-tx rejected:.*TxDispatchError/i, {
            timeout: 90_000,
        });
        // And onStatus("error") fires before the reject, giving us a
        // typed error surface to render.
        await expect(logLoc).toContainText(/bad-tx: error/, { timeout: 5_000 });

        // Exactly one sign payload was recorded.
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(1);
        expect(signingLog[0].type).toBe("payload");

        await expect(btn).toBeEnabled({ timeout: 10_000 });
    });
});
