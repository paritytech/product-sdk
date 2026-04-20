import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * KvStore CRUD operations through the Host API path.
 *
 * Exercises:
 *   - KvStore.set() / .get() — string round-trip via host localStorage bridge
 *   - KvStore.setJSON() / .getJSON() — JSON serialization round-trip
 *   - KvStore.remove() — key deletion
 *   - Missing key handling — returns null
 *   - Host routing — verifies data lands in the host page's localStorage
 *
 * Host API surface tested:
 *   - hostStorage.writeString(key, value)
 *   - hostStorage.readString(key)
 *   - hostStorage.writeJSON(key, value)
 *   - hostStorage.readJSON(key)
 *   - hostStorage.clear(key)
 */
test.describe("@polkadot-apps/storage via Host API — KvStore operations", () => {
    test("set + get round-trip", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Fill key and value
        await frame.locator('[data-testid="kv-key-input"]').fill("e2e-str");
        await frame.locator('[data-testid="kv-value-input"]').fill("hello-kv");

        // Set
        await frame.locator('[data-testid="btn-set"]').click();
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /Set "e2e-str" = "hello-kv"/i,
            { timeout: 30_000 },
        );

        // Get
        await frame.locator('[data-testid="btn-get"]').click();
        await expect(frame.locator('[data-testid="last-get-value"]')).toHaveText("hello-kv", {
            timeout: 30_000,
        });
    });

    test("setJSON + getJSON round-trip", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Fill key and value
        await frame.locator('[data-testid="kv-key-input"]').fill("e2e-json");
        await frame.locator('[data-testid="kv-value-input"]').fill("json-test");

        // Set JSON (stores { text: "json-test", n: 42 })
        await frame.locator('[data-testid="btn-set-json"]').click();
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /Set JSON "e2e-json"/i,
            { timeout: 30_000 },
        );

        // Get JSON
        await frame.locator('[data-testid="btn-get-json"]').click();
        await expect(frame.locator('[data-testid="last-get-value"]')).toContainText(
            '"text":"json-test"',
            { timeout: 30_000 },
        );
        await expect(frame.locator('[data-testid="last-get-value"]')).toContainText('"n":42');
    });

    test("remove deletes key", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Set a key first
        await frame.locator('[data-testid="kv-key-input"]').fill("e2e-remove");
        await frame.locator('[data-testid="kv-value-input"]').fill("to-remove");
        await frame.locator('[data-testid="btn-set"]').click();
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /Set "e2e-remove"/i,
            { timeout: 30_000 },
        );

        // Remove the key
        await frame.locator('[data-testid="btn-remove"]').click();
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /Removed "e2e-remove"/i,
            { timeout: 30_000 },
        );

        // Get should return null
        await frame.locator('[data-testid="btn-get"]').click();
        await expect(frame.locator('[data-testid="last-get-value"]')).toHaveText("null", {
            timeout: 30_000,
        });
    });

    test("get missing key returns null", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Fill a key that was never set
        await frame.locator('[data-testid="kv-key-input"]').fill("non-existent-key-xyz");

        // Get should return null
        await frame.locator('[data-testid="btn-get"]').click();
        await expect(frame.locator('[data-testid="last-get-value"]')).toHaveText("null", {
            timeout: 30_000,
        });
    });

    test("host routing verification", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Set a key via the app
        await frame.locator('[data-testid="kv-key-input"]').fill("e2e-host-check");
        await frame.locator('[data-testid="kv-value-input"]').fill("routed");
        await frame.locator('[data-testid="btn-set"]').click();
        await expect(frame.locator('[data-testid="storage-log"]')).toContainText(
            /Set "e2e-host-check" = "routed"/i,
            { timeout: 30_000 },
        );

        // Verify the value landed in the host page's localStorage with "test-host:" prefix
        const hostValue = await testHost.page.evaluate(() =>
            localStorage.getItem("test-host:e2e-host-check"),
        );
        expect(hostValue).toBe("routed");
    });
});
