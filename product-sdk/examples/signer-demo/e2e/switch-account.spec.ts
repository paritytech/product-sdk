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

        await testHost.switchAccount("charlie");

        // `waitForConnection()` would hang: it polls the host's view of the
        // product link, which only moves when a frame arrives from the product,
        // and a live switch sends none. The core instead pushes the switch down
        // `account.connectionStatusSubscribe()`, which SignerManager reacts to
        // by starting a reconnect — so gate on that reconnect starting.
        //
        // Not on it finishing: the reconnect races the host's session re-mint
        // and loses often enough to flake a "connecting → connected" gate.
        await expect
            .poll(
                async () =>
                    Number(
                        await frame.locator('[data-testid="transition-count"]').textContent(),
                    ),
                { timeout: 30_000 },
            )
            .toBeGreaterThanOrEqual(transitionCountBefore + 1);

        // Not `.last()`: when the reconnect does win, `connecting → connected`
        // lands after the row we are looking for.
        const rowsAfterSwitch = (
            await frame.locator('[data-testid="transition-row"]').allTextContents()
        ).slice(transitionCountBefore);
        expect(rowsAfterSwitch).toContain("connected → connecting");

        // When the reconnect loses that race it re-queries the product account
        // before the core has re-minted the SSO session, gets `NotConnected`,
        // and never retries — `connect()`'s `dappName` branch
        // (`packages/signer/src/providers/host.ts:751-777`) soft-degrades to an
        // empty account list on any fetch failure. Waiting cannot recover it;
        // a reload forces the clean re-handshake.
        // TODO(test-sdk-switch-account): make that branch check `nonTransient`
        // and retry, as its `productAccount` sibling does, then drop the reload.
        await testHost.page.reload();
        await waitForAppReady(testHost);

        // The fixture pins "signer-demo.dot" to bob, so this comparison alone
        // would pass even against a no-op switchAccount(). The gate above is
        // what rules that out.
        // TODO(test-sdk-switch-account): proving the address *would* change for
        // a product that isn't dapp-scoped needs an unpinned fixture.
        const afterAddress = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(afterAddress).toBeTruthy();
        expect(afterAddress).toEqual(beforeAddress);

        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText("connected");
    });
});
