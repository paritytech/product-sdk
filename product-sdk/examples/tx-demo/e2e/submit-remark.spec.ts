import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@polkadot-apps/tx via Host API", () => {
    test("app boots and exposes Bob's account with the Paseo Asset Hub prefix", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        await expect(frame.locator('[data-testid="app-heading"]')).toBeVisible();
        await expect(frame.locator('[data-testid="active-provider"]')).toHaveText("host");

        // SS58 prefix 0 → addresses start with "1"
        const addr = await frame.locator('[data-testid="account-address"]').textContent();
        expect(addr).toBeTruthy();
        const expectedStart = SS58_PREFIX === 0 ? "1" : "5";
        expect(addr!.startsWith(expectedStart)).toBe(true);
    });

    test("submitAndWatch: single remark is signed via the host and lands on-chain", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        // Clear signing log so only this test's activity is counted.
        await testHost.clearSigningLog();

        const btn = frame.locator('[data-testid="btn-submit-remark"]');
        await btn.click();

        // Button disables during submission.
        await expect(btn).toBeDisabled();

        // "landed in block #N" is logged after submitAndWatch resolves at best-block.
        await expect(frame.locator('[data-testid="tx-log"]')).toContainText(/landed in block #\d+/, {
            timeout: 90_000,
        });

        // Button re-enables.
        await expect(btn).toBeEnabled({ timeout: 10_000 });

        // The signer was invoked exactly once through the host.
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(1);
        expect(signingLog[0].type).toBe("payload");
    });

    test("batchSubmitAndWatch: three remarks land in a single extrinsic", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        const btn = frame.locator('[data-testid="btn-submit-batch"]');
        await btn.click();
        await expect(btn).toBeDisabled();

        await expect(frame.locator('[data-testid="tx-log"]')).toContainText(
            /batch landed in block #\d+/,
            { timeout: 90_000 },
        );
        await expect(btn).toBeEnabled({ timeout: 10_000 });

        // Utility.batch_all wraps 3 inner calls into one extrinsic → one signature.
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(1);
        expect(signingLog[0].type).toBe("payload");
    });
});
