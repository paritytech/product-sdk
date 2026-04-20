import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * `submitAndWatch` exposes an `onStatus` callback that fires on each
 * lifecycle transition. The demo's `makeStatusLogger` appends a log line
 * per transition, giving us a stable string-ordering guarantee:
 *
 *   signing  →  broadcasting  →  in best block  →  finalized
 *
 * Regressions in `submit.ts` that swap the order, drop a callback, or
 * emit `in-block` before `signed` would fail this spec. We keep the
 * assertion structural (substring indices) rather than flaky-timing-based.
 */
test.describe("@polkadot-apps/tx via Host API — onStatus ordering", () => {
    test("signing → broadcasting → in-block transitions fire in order", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="btn-submit-remark"]').click();

        const logLoc = frame.locator('[data-testid="tx-log"]');
        // Wait until the full best-block sequence has played out.
        await expect(logLoc).toContainText(/remark: in best block/, { timeout: 90_000 });

        const text = (await logLoc.textContent()) ?? "";
        const idxSigning = text.indexOf("remark: signing");
        const idxBroadcasting = text.indexOf("remark: broadcasting");
        const idxInBlock = text.indexOf("remark: in best block");

        expect(idxSigning).toBeGreaterThan(-1);
        expect(idxBroadcasting).toBeGreaterThan(-1);
        expect(idxInBlock).toBeGreaterThan(-1);
        expect(idxSigning).toBeLessThan(idxBroadcasting);
        expect(idxBroadcasting).toBeLessThan(idxInBlock);
    });
});
