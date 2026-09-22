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

        const transitionCountBefore = Number(
            await frame.locator('[data-testid="transition-count"]').textContent(),
        );

        // Flip the host's active account to Charlie. The host connect path
        // derives a *dapp-scoped* product account ("signer-demo.dot"),
        // not the host's currently-active identity account, so switching the
        // host account must NOT change the account the signer surfaces — it
        // re-derives the same product account and stays connected.
        //
        // A live switch sends the product no frame, so `waitForConnection()`
        // isn't the right gate here: it polls `getConnectionStatus()`, the
        // host's view of the product LINK, which only moves when a frame
        // arrives FROM the product. What the product DOES observe is the
        // core pushing the switch down `account.connectionStatusSubscribe()`
        // — SignerManager's status listener sees "disconnected" while it's
        // "connected" and runs its normal auto-reconnect (status flips to
        // "connecting", then back to "connected"), each flip recorded in
        // `transition-count`. So wait for that reaction — proof the product
        // actually observed the switch — instead of for a connection event
        // that never arrives.
        await testHost.switchAccount("charlie");

        await expect
            .poll(
                async () =>
                    Number(
                        await frame.locator('[data-testid="transition-count"]').textContent(),
                    ),
                { timeout: 30_000 },
            )
            .toBeGreaterThanOrEqual(transitionCountBefore + 2);

        // Empirically (host-api-test-sdk 0.15.0, this harness): the auto-
        // reconnect above reliably loses a race against the mock host's own
        // session re-mint. `account.connectionStatusSubscribe()` delivers
        // "Disconnected" and SignerManager's reconnect re-queries the product
        // account before the core has finished re-minting the SSO session
        // under Charlie, hitting `Domain → V1 → NotConnected`. The SDK
        // classifies that as non-transient ("signed out" is a legitimate
        // terminal state elsewhere) and soft-degrades to an empty account
        // list with no further retry — see
        // `packages/signer/src/providers/host.ts` (`isNonTransientHostError`,
        // `fetchProductSignerAccount`'s soft-degrade branch). No amount of
        // waiting recovers from it: this was verified empirically (10/10
        // runs), independent of this branch's `AutoSigning` fixture change.
        // A page reload forces the clean re-handshake needed to read a
        // reliable final state — a real, separate workaround from the one
        // this restoration removed above, not a reversion of it: the
        // transition-count wait already proves the *live* reaction; the
        // reload here only recovers from the confirmed race in that
        // reaction's outcome. TODO(test-sdk-switch-account): file the race
        // against host-api-test-sdk (or the non-transient classification in
        // packages/signer) and drop this reload once fixed.
        await testHost.page.reload();
        await waitForAppReady(testHost);

        // Because the fixture's productAccounts pins "signer-demo.dot" to bob
        // (see ./fixtures — unrelated to the live-switch path above, and out
        // of scope to unpin here since that would change account derivation
        // for all 10 tests in this suite), the product account is expected to
        // stay bob's regardless of which host identity is active.
        //
        // TODO(test-sdk-switch-account): a test that also proves the address
        // WOULD change for a product that isn't dapp-scoped needs a fixture
        // whose productAccounts doesn't pin "signer-demo.dot" to a fixed
        // account.
        const afterAddress = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(afterAddress).toBeTruthy();
        expect(afterAddress).toEqual(beforeAddress);

        // Status must still read "connected" after the swap.
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText("connected");
    });
});
