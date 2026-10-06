// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — getProductAccount", () => {
    test("returns an app-scoped address for a dotNS identifier", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        const selectedAddr = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();

        // At this test-host version a product account resolves to the session's
        // own account. A later version derives it from (session root, product
        // id) instead, at which point this becomes an inequality.
        await frame.locator('[data-testid="dotns-input"]').fill("signer-demo.dot");
        await frame.locator('[data-testid="btn-get-product-account"]').click();

        const productLoc = frame.locator('[data-testid="product-account-address"]');
        await expect(productLoc).toHaveText(/^1[1-9A-HJ-NP-Za-km-z]+$/, { timeout: 30_000 });

        const productAddr = await productLoc.textContent();
        expect(productAddr).toBe(selectedAddr);

        // An unmapped identifier still answers a valid address, and a distinct
        // one: the identifier feeds whatever scoping the host applies.
        await frame.locator('[data-testid="dotns-input"]').fill("derived-app.dot");
        await frame.locator('[data-testid="btn-get-product-account"]').click();

        await expect(productLoc).toHaveText(/^1[1-9A-HJ-NP-Za-km-z]+$/, { timeout: 30_000 });
        const derivedAddr = await productLoc.textContent();
        expect(derivedAddr).not.toBe(productAddr);
        expect(derivedAddr).not.toBe(selectedAddr);
    });
});
