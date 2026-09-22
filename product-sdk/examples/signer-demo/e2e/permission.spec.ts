// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — permission rejection", () => {
    // workers:1 means this test's decision state would leak into later specs
    // if we don't reset. approve-all + explicit grant restores the default
    // the fixture would provide at startup.
    test.afterEach(async ({ testHost }) => {
        await testHost.setPermissionBehavior("approve-all");
        await testHost.setUserConfirmationBehavior("approve-all");
        await testHost.grantPermission("ChainSubmit");
    });

    // The original test asserted that signRaw fails after `revokePermission`,
    // but on test-sdk 0.14 `revokePermission()` was a no-op against the core:
    // it only touched the host's own `getGrantedPermissions()` set, so the
    // core kept serving the product from its previously stored grant without
    // asking again or logging anything — `getPermissionLog()` stayed empty
    // and this couldn't be exercised end-to-end. Fixed in 0.15.0:
    // `revokePermission()` now reaches the core, so `setPermissionBehavior`
    // + `revokePermission` + a reconnect produces a denied entry in
    // `getPermissionLog()` again, as verified against 0.15.0 — the restored
    // sequence below (`setPermissionBehavior("reject-all")` →
    // `revokePermission("ChainSubmit")` → `clearPermissionLog()` →
    // reconnect) produces a `ChainSubmit` entry with `approved: false` /
    // `decision: "Deny"` after the reconnect, before any signature.
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
        expect(chainSubmit?.decision).toBe("Deny");
    });
});
