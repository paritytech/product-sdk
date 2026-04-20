import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers `submitAndWatch(tx, signer, { waitFor: "finalized" })`.
 *
 * The promise must resolve only after a relay-chain-finalized event, not
 * merely best-block inclusion. We assert the blue `.log-finalized` line
 * appears, which is only emitted when `onStatus("finalized")` fires *and*
 * the promise has resolved. Paseo AH finality typically lands in
 * 20–60 s — the 120 s timeout gives comfortable headroom.
 */
test.describe("@polkadot-apps/tx via Host API — finalized", () => {
    test("waitFor=finalized resolves only after finalization", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        const btn = frame.locator('[data-testid="btn-submit-remark-finalized"]');
        await btn.click();
        await expect(btn).toBeDisabled();

        // "remark-finalized finalized in block #N" is logged *after* the
        // promise resolves, which only happens on the finalized event.
        await expect(frame.locator('[data-testid="tx-log"]')).toContainText(
            /remark-finalized finalized in block #\d+/,
            { timeout: 120_000 },
        );

        // Exactly one extrinsic was signed — the finalization wait must not
        // cause a duplicate broadcast or re-sign.
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(1);
        expect(signingLog[0].type).toBe("payload");

        await expect(btn).toBeEnabled({ timeout: 10_000 });
    });
});
