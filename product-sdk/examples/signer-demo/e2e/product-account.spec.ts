import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@polkadot-apps/signer — getProductAccount", () => {
    test("returns an app-scoped address mapped via productAccounts", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        const selectedAddr = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();

        // The fixture maps "signer-demo.dot/0" → Bob, so getProductAccount
        // with that DotNS identifier should round-trip through handleAccountGet
        // and resolve to Bob's public key encoded with SS58 prefix 0. That
        // matches the first non-product account the app already selected,
        // so they should be identical.
        await frame.locator('[data-testid="dotns-input"]').fill("signer-demo.dot");
        await frame.locator('[data-testid="btn-get-product-account"]').click();

        const productLoc = frame.locator('[data-testid="product-account-address"]');
        await expect(productLoc).toHaveText(/^1[1-9A-HJ-NP-Za-km-z]+$/, { timeout: 30_000 });

        const productAddr = await productLoc.textContent();
        expect(productAddr).toBe(selectedAddr);

        // An unmapped DotNS identifier still works: the test SDK derives
        // "//Bob//<dotns>/<index>" as a fresh keypair. The address must be
        // a valid SS58 starting with "1" and different from Bob's primary.
        await frame.locator('[data-testid="dotns-input"]').fill("derived-app.dot");
        await frame.locator('[data-testid="btn-get-product-account"]').click();

        await expect(productLoc).toHaveText(/^1[1-9A-HJ-NP-Za-km-z]+$/, { timeout: 30_000 });
        const derivedAddr = await productLoc.textContent();
        expect(derivedAddr).not.toBe(selectedAddr);
    });
});
