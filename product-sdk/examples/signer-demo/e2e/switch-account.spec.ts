// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — testHost.switchAccount", () => {
    test("host account switch keeps the dapp-scoped product account stable", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        const beforeAddress = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(beforeAddress).toBeTruthy();

        // Flip the host's active account to Charlie. The host connect path
        // derives a *dapp-scoped* product account ("signer-demo.dot/0"),
        // not the host's currently-active identity account, so switching the
        // host account must NOT change the account the signer surfaces — it
        // re-derives the same product account and stays connected.
        // host-api-test-sdk 0.14 re-mints the host session without reloading the
        // product iframe or notifying the product, so nothing would prompt a
        // re-handshake on its own — reload to force one.
        //
        // What this proves, post-0.14: that the dapp-scoped product account is
        // re-derived from "signer-demo.dot" on a reconnect and does not bind to
        // whichever identity happens to be active on the host at that moment.
        //
        // What this does NOT prove: that the product survives a *live* account
        // switch with no reload in between. 0.14's switchAccount() re-mints the
        // host session without notifying the product, so there is no
        // product-visible event to react to — that path is not exercisable
        // through this SDK version. And because the fixture's productAccounts
        // pins "signer-demo.dot" to bob (see ./fixtures), this test would also
        // pass if switchAccount() were a complete no-op — the reload alone,
        // with no switch at all, would derive the same address. Keeping this
        // test is a deliberate choice: it still guards the regression class
        // where derivation wrongly binds to the host's active identity across
        // a reconnect, which is real and worth keeping green.
        //
        // TODO(test-sdk-switch-account): restoring a meaningful live-switch
        // assertion (no reload) needs either an upstream switchAccount() that
        // notifies the product, or a fixture whose productAccounts doesn't pin
        // "signer-demo.dot" to a fixed account.
        await testHost.switchAccount("charlie");
        await testHost.page.reload();
        await waitForAppReady(testHost);

        const afterAddress = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(afterAddress).toBeTruthy();
        expect(afterAddress).toEqual(beforeAddress);

        // Status must still read "connected" after the swap.
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText("connected");
    });
});
