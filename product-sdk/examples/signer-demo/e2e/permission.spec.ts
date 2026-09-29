// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — permission rejection", () => {
    // No afterEach reset despite workers:1 — createTestHostFixture stands up a
    // fresh host server per test, so none of this state outlives the test.

    test("connect tolerates a denied ChainSubmit auto-request when host is in reject-all", async ({
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
