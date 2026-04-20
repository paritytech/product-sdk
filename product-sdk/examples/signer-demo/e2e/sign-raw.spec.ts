import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@polkadot-apps/signer — signRaw", () => {
    test("returns a hex signature and the host receives a raw sign request", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="raw-input"]').fill("e2e-signer-demo");
        await frame.locator('[data-testid="btn-sign-raw"]').click();

        // Signature hex appears (66 chars = 2 for "0x" + 64-byte sr25519).
        const sigLoc = frame.locator('[data-testid="last-signature"]');
        await expect(sigLoc).toHaveText(/^0x[0-9a-f]+$/i, { timeout: 30_000 });
        const sig = await sigLoc.textContent();
        expect(sig!.length).toBeGreaterThan(2);

        // Button re-enables after the promise resolves.
        await expect(frame.locator('[data-testid="btn-sign-raw"]')).toBeEnabled();

        // The host's raw-sign handler was hit exactly once.
        const log = await testHost.getSigningLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe("raw");
    });
});
