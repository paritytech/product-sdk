// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — permission rejection", () => {
    // No afterEach reset despite workers:1 — createTestHostFixture stands up a
    // fresh host server per test, so none of this state outlives the test.

    // The original test asserted that signRaw fails after `revokePermission`,
    // but test SDK 0.7.5 exposes `setEnforcePermissions` without wiring it —
    // signing handlers ignore the granted-permissions state, so revoke + sign
    // can't be exercised end-to-end yet. This test asserts the layer above
    // that *is* exercisable: the host records denied ChainSubmit auto-requests,
    // and the SignerManager tolerates the denial (matching real-host behavior:
    // log a warning, keep the connection alive, defer the actual failure to
    // sign-time when the host would refuse).
    // SKIPPED against a TrUAPI host. This asserts behaviour that exists only in
    // the Novasama reimplementation @parity/host-api-test-sdk is built on:
    // there is no core there, so nothing caches a permission decision and a
    // mid-run revoke takes effect. A real TrUAPI core persists a decided
    // authorization per (product, permission) and answers from its own storage,
    // so the second request never reaches the host and the log stays empty.
    //
    // No test host can change that. Re-enable only if the core gains per-call
    // permission checks, or rewrite the test to assert the caching instead.
    test.skip("connect tolerates a denied ChainSubmit auto-request when host is in reject-all", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        // Revoking is what forces a re-ask: a standing grant is answered from
        // the core's stored decision, silently and without a log entry.
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
