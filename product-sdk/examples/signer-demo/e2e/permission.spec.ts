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
    // but on test-sdk 0.14 the legacy permission mechanism
    // (`setPermissionBehavior` / `grantPermission` / `revokePermission` /
    // `getPermissionLog()`) has no effect on this connect-time auto-request —
    // see the note below, it moved to a `ResourceAllocation` user-confirmation
    // request instead — so revoke + sign can't be exercised end-to-end through
    // the permission API yet. This test asserts the layer above that *is*
    // exercisable: the host records a denied auto-request during connect, and
    // the SignerManager tolerates the denial (matching real-host behavior: log
    // a warning, keep the connection alive, defer the actual failure to
    // sign-time when the host would refuse).
    //
    // test-sdk 0.14 (Task 5b): the connect-time auto-request this test
    // exercises no longer goes through the legacy permission mechanism at
    // all — `setPermissionBehavior` / `revokePermission("ChainSubmit")` /
    // `getPermissionLog()` have no effect on it. It is now a user-confirmation
    // request tagged `ResourceAllocation`, gated by `setUserConfirmationBehavior`
    // and recorded in `getUserConfirmationLog()`. Confirmed via the Step 3
    // probe (see task-5b-report.md): with the legacy permission calls alone,
    // `getPermissionLog()` stayed empty; only adding
    // `setUserConfirmationBehavior("reject-all")` produced a denied
    // `ResourceAllocation` entry in `getUserConfirmationLog()`.
    test("connect tolerates a denied ResourceAllocation auto-request when host is in reject-all", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        // Drop the initially-granted confirmation state.
        await frame.locator('[data-testid="btn-disconnect"]').click();
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText(
            "disconnected",
        );

        await testHost.setUserConfirmationBehavior("reject-all");
        await testHost.clearUserConfirmationLog();

        // Reconnect — the SignerManager's auto-request now hits a host that
        // denies everything.
        await frame.locator('[data-testid="btn-connect"]').click();
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText(
            "connected",
            { timeout: 30_000 },
        );
        await expect(frame.locator('[data-testid="last-error"]')).toBeEmpty();

        // Host saw and denied the auto-request.
        const log = await testHost.getUserConfirmationLog();
        const resourceAllocation = log.find((e) => e.tag === "ResourceAllocation");
        expect(
            resourceAllocation,
            "expected a ResourceAllocation entry in the user-confirmation log",
        ).toBeDefined();
        expect(resourceAllocation?.approved).toBe(false);
    });
});
