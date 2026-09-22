// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Prefix namespacing through the Host API path.
 *
 * Exercises:
 *   - createLocalKvStore({ prefix: "demo" }) → keys stored as "demo:key" on the host
 *   - Prefixed and unprefixed stores don't collide on the same key name
 *
 * Host API surface tested:
 *   - hostStorage.writeString("demo:key", value) — prefixed key routing
 *   - hostStorage.readString("demo:key") — prefixed key retrieval
 *   - Key isolation between prefixed and unprefixed stores
 */
test.describe("@parity/product-sdk-local-storage via Host API — prefix namespacing", () => {
    test("prefixed store uses prefix:key format", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Fill key and value
        await frame.locator('[data-testid="kv-key-input"]').fill("mykey");
        await frame.locator('[data-testid="kv-value-input"]').fill("prefixed-val");

        // Set via prefixed store
        await frame.locator('[data-testid="btn-set-prefixed"]').click();
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /Set prefixed "demo:mykey"/i,
            { timeout: 30_000 },
        );

        // Get via prefixed store
        await frame.locator('[data-testid="btn-get-prefixed"]').click();
        await expect(frame.locator('[data-testid="prefixed-get-value"]')).toHaveText(
            "prefixed-val",
            { timeout: 30_000 },
        );

        // Verify host-side: the SDK's prefix:key composition ("demo:mykey") must
        // still be observable. test-sdk 0.14.0's host core is WebAssembly-backed
        // and namespaces product storage per product (confirmed by probe:
        // `truapi:product-storage:v1:<n>:<productId>:<key>`), so the raw
        // `test-host:` localStorage prefix no longer exists — read through
        // getProductStorage() and match on the local key's suffix, since only
        // the local key (not the namespacing prefix) is documented.
        const storage = await testHost.getProductStorage();
        const entry = Object.entries(storage).find(([key]) => key.endsWith(":demo:mykey"));
        expect(entry, "expected a demo:mykey entry in product storage").toBeDefined();
        expect(entry?.[1]).toBe("prefixed-val");
    });

    test("prefixed and unprefixed stores don't collide", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Set "shared" key via unprefixed store
        await frame.locator('[data-testid="kv-key-input"]').fill("shared");
        await frame.locator('[data-testid="kv-value-input"]').fill("from-unprefixed");
        await frame.locator('[data-testid="btn-set"]').click();
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /Set "shared" = "from-unprefixed"/i,
            { timeout: 30_000 },
        );

        // Set "shared" key via prefixed store
        await frame.locator('[data-testid="kv-value-input"]').fill("from-prefixed");
        await frame.locator('[data-testid="btn-set-prefixed"]').click();
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /Set prefixed "demo:shared" = "from-prefixed"/i,
            { timeout: 30_000 },
        );

        // Get from unprefixed store — should be "from-unprefixed"
        await frame.locator('[data-testid="btn-get"]').click();
        await expect(frame.locator('[data-testid="last-get-value"]')).toHaveText(
            "from-unprefixed",
            { timeout: 30_000 },
        );

        // Get from prefixed store — should be "from-prefixed"
        await frame.locator('[data-testid="btn-get-prefixed"]').click();
        await expect(frame.locator('[data-testid="prefixed-get-value"]')).toHaveText(
            "from-prefixed",
            { timeout: 30_000 },
        );
    });
});
