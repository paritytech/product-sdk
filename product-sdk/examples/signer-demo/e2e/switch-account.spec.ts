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
        // by starting a reconnect — so gate on that reconnect starting. Its
        // completion is covered by the connection-status assertion at the end.
        await expect
            .poll(
                async () =>
                    Number(
                        await frame.locator('[data-testid="transition-count"]').textContent(),
                    ),
                { timeout: 30_000 },
            )
            .toBeGreaterThanOrEqual(transitionCountBefore + 1);

        // Not `.last()`: `connecting → connected` lands after the row we want
        // once the reconnect completes.
        const rowsAfterSwitch = (
            await frame.locator('[data-testid="transition-row"]').allTextContents()
        ).slice(transitionCountBefore);
        expect(rowsAfterSwitch).toContain("connected → connecting");

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
