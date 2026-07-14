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
        await testHost.switchAccount("charlie");
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
