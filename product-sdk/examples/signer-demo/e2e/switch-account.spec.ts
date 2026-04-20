import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@polkadot-apps/signer — testHost.switchAccount", () => {
    test("account swap propagates through SignerManager.subscribe", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        const bobAddress = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(bobAddress).toBeTruthy();

        // Flip the host's active non-product account to Charlie. This
        // re-creates the product-sdk container, which the signer's
        // `HostProvider` picks up via `onAccountsChange` + its connection
        // status subscription. A new SignerManager.connect() kicks off in
        // main.ts via the reload, so we wait for the post-switch ready
        // state before asserting.
        await testHost.switchAccount("charlie");
        await waitForAppReady(testHost);

        const charlieAddress = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(charlieAddress).toBeTruthy();
        expect(charlieAddress).not.toEqual(bobAddress);

        // Status must still read "connected" after the swap.
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText("connected");
    });
});
