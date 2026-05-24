import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — permission rejection", () => {
    // workers:1 means this test's permission state would leak into later
    // specs if we don't reset. approve-all + explicit grant restores the
    // default the fixture would provide at startup.
    test.afterEach(async ({ testHost }) => {
        await testHost.setPermissionBehavior("approve-all");
        await testHost.grantPermission("ChainSubmit");
    });

    // The original test asserted that signRaw fails after `revokePermission`,
    // but test SDK 0.7.5 exposes `setEnforcePermissions` without wiring it —
    // signing handlers ignore the granted-permissions state, so revoke + sign
    // can't be exercised end-to-end yet. This test asserts the layer above
    // that *is* exercisable: the host records denied ChainSubmit auto-requests,
    // and the SignerManager tolerates the denial (matching real-host behavior:
    // log a warning, keep the connection alive, defer the actual failure to
    // sign-time when the host would refuse).
    test("connect tolerates a denied ChainSubmit auto-request when host is in reject-all", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        // Drop the initially-granted permission state.
        await frame.locator('[data-testid="btn-disconnect"]').click();
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText(
            "disconnected",
        );

        await testHost.setPermissionBehavior("reject-all");
        await testHost.revokePermission("ChainSubmit");
        await testHost.clearPermissionLog();

        // Reconnect — the SignerManager's auto-request now hits a host that
        // denies everything.
        await frame.locator('[data-testid="btn-connect"]').click();
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText(
            "connected",
            { timeout: 30_000 },
        );
        await expect(frame.locator('[data-testid="last-error"]')).toBeEmpty();

        // Host saw and denied the auto-request.
        const log = await testHost.getPermissionLog();
        const chainSubmit = log.find((e) => e.tag === "ChainSubmit");
        expect(chainSubmit, "expected a ChainSubmit entry in the permission log").toBeDefined();
        expect(chainSubmit?.approved).toBe(false);
    });
});
