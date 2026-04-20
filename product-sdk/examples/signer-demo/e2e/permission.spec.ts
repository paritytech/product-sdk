import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@polkadot-apps/signer — permission rejection", () => {
    // workers:1 means this test's permission state would leak into later
    // specs if we don't reset. approve-all + explicit grant restores the
    // default the fixture would provide at startup.
    test.afterEach(async ({ testHost }) => {
        await testHost.setPermissionBehavior("approve-all");
        await testHost.grantPermission("TransactionSubmit");
    });

    test("signRaw surfaces a typed SignerError when permission is revoked", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        // The initial connect() already pulled a granted permission via the
        // auto-request flow. To exercise the rejection path we revoke it and
        // flip the behavior so re-requests are denied.
        await testHost.revokePermission("TransactionSubmit");
        await testHost.setPermissionBehavior("reject-all");
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="raw-input"]').fill("should-be-rejected");
        await frame.locator('[data-testid="btn-sign-raw"]').click();

        // The error text ends up in both the signature slot and the
        // dedicated last-error slot (surfaced through SignerManager's
        // subscribe state). The signer manager maps host-side rejection
        // to SigningFailedError; the exact cause text depends on
        // product-sdk, so we match loosely.
        const errLoc = frame.locator('[data-testid="last-error"]');
        await expect(errLoc).toContainText(/SigningFailedError/i, { timeout: 30_000 });

        // Signature slot must NOT contain a hex signature.
        const sig = await frame.locator('[data-testid="last-signature"]').textContent();
        expect(sig).not.toMatch(/^0x[0-9a-f]+$/i);

        // The host's raw-sign handler was reached but rejected — the
        // signing log should not record a successful raw entry.
        const log = await testHost.getSigningLog();
        expect(log).toHaveLength(0);
    });
});
