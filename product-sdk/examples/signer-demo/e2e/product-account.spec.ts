// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — getProductAccount", () => {
    test("returns the address the host derived for this product", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        const selectedAddr = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();

        // A product account is derived from (session root, product id), so it
        // is its own account rather than the signed-in one.
        await frame.locator('[data-testid="dotns-input"]').fill("signer-demo.dot");
        await frame.locator('[data-testid="btn-get-product-account"]').click();

        const productLoc = frame.locator('[data-testid="product-account-address"]');
        await expect(productLoc).toHaveText(/^1[1-9A-HJ-NP-Za-km-z]+$/, { timeout: 30_000 });

        const productAddr = await productLoc.textContent();
        // Its own account, not the signed-in one. That inequality is the whole
        // behavioural change: the old package mapped a product to a chosen
        // account, so this used to be an equality. What the derivation itself
        // produces is pinned host-side, in `@parity/truapi-host`'s own
        // `product-account.test.ts` -- a consumer suite should not re-derive it.
        expect(productAddr).not.toBe(selectedAddr);

        // The product id feeds the derivation, so a second one is a second,
        // distinct account.
        await frame.locator('[data-testid="dotns-input"]').fill("derived-app.dot");
        await frame.locator('[data-testid="btn-get-product-account"]').click();

        await expect(productLoc).toHaveText(/^1[1-9A-HJ-NP-Za-km-z]+$/, { timeout: 30_000 });
        const derivedAddr = await productLoc.textContent();
        expect(derivedAddr).not.toBe(productAddr);
        expect(derivedAddr).not.toBe(selectedAddr);
    });
});
