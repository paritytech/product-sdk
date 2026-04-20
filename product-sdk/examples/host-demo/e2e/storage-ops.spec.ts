import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Host localStorage operations through the Host API path.
 *
 * Exercises:
 *   - hostLocalStorage.writeString() / readString()
 *   - hostLocalStorage.writeJSON() / readJSON()
 *   - hostLocalStorage.clear()
 *   - Host-side storage verification (reads directly from the host page's localStorage)
 *
 * Host API surface tested:
 *   - product-sdk hostLocalStorage.writeString(key, value)
 *   - product-sdk hostLocalStorage.readString(key)
 *   - product-sdk hostLocalStorage.writeJSON(key, value)
 *   - product-sdk hostLocalStorage.readJSON(key)
 *   - product-sdk hostLocalStorage.clear(key)
 */
test.describe("@polkadot-apps/host via Host API — localStorage operations", () => {
    test("writeString + readString round-trip", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Fill key and value
        await frame.locator('[data-testid="storage-key-input"]').fill("e2e-str");
        await frame.locator('[data-testid="storage-value-input"]').fill("hello-world");

        // Write string
        await frame.locator('[data-testid="btn-write-string"]').click();
        await expect(frame.locator('[data-testid="host-log"]')).toContainText(
            /writeString.*success/i,
            { timeout: 30_000 },
        );

        // Read string back
        await frame.locator('[data-testid="btn-read-string"]').click();
        await expect(frame.locator('[data-testid="last-read-value"]')).toHaveText("hello-world", {
            timeout: 30_000,
        });
    });

    test("writeJSON + readJSON round-trip", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Fill key and value
        await frame.locator('[data-testid="storage-key-input"]').fill("e2e-json");
        await frame.locator('[data-testid="storage-value-input"]').fill("test-json");

        // Write JSON (writes { text: "test-json", n: 42 })
        await frame.locator('[data-testid="btn-write-json"]').click();
        await expect(frame.locator('[data-testid="host-log"]')).toContainText(
            /writeJSON.*success/i,
            { timeout: 30_000 },
        );

        // Read JSON back
        await frame.locator('[data-testid="btn-read-json"]').click();
        const readValue = frame.locator('[data-testid="last-read-value"]');
        await expect(readValue).toContainText('"text":"test-json"', { timeout: 30_000 });
        await expect(readValue).toContainText('"n":42');
    });

    test("clear removes key", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Write a value first
        await frame.locator('[data-testid="storage-key-input"]').fill("e2e-clear");
        await frame.locator('[data-testid="storage-value-input"]').fill("to-delete");

        await frame.locator('[data-testid="btn-write-string"]').click();
        await expect(frame.locator('[data-testid="host-log"]')).toContainText(
            /writeString.*success/i,
            { timeout: 30_000 },
        );

        // Clear the key
        await frame.locator('[data-testid="btn-clear"]').click();
        await expect(frame.locator('[data-testid="host-log"]')).toContainText(
            /clear.*success/i,
            { timeout: 30_000 },
        );

        // Read should return null
        await frame.locator('[data-testid="btn-read-string"]').click();
        await expect(frame.locator('[data-testid="last-read-value"]')).toHaveText("null", {
            timeout: 30_000,
        });
    });

    test("read missing key returns null", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Use a key that was never written
        await frame.locator('[data-testid="storage-key-input"]').fill("non-existent-key-12345");

        // Read should return null
        await frame.locator('[data-testid="btn-read-string"]').click();
        await expect(frame.locator('[data-testid="last-read-value"]')).toHaveText("null", {
            timeout: 30_000,
        });
    });

    test("host-side storage verification", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Write a value via the product frame
        await frame.locator('[data-testid="storage-key-input"]').fill("e2e-verify");
        await frame.locator('[data-testid="storage-value-input"]').fill("host-check");

        await frame.locator('[data-testid="btn-write-string"]').click();
        await expect(frame.locator('[data-testid="host-log"]')).toContainText(
            /writeString.*success/i,
            { timeout: 30_000 },
        );

        // Verify the value is stored in the HOST page's localStorage with the test-host: prefix
        const storedValue = await testHost.page.evaluate(() =>
            localStorage.getItem("test-host:e2e-verify"),
        );
        expect(storedValue).toBe("host-check");
    });
});
