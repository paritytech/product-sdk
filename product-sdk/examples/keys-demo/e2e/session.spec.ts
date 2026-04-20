import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Session key lifecycle through the Host API path.
 *
 * Exercises:
 *   - SessionKeyManager.create() — generates mnemonic, persists to host storage
 *   - SessionKeyManager.getOrCreate() — loads existing or creates new
 *   - SessionKeyManager.clear() — removes from host storage
 *   - Host-side storage verification (reads directly from the host page's localStorage)
 *
 * Host API surface tested:
 *   - KvStore.set(key, value) via product-sdk hostLocalStorage
 *   - KvStore.get(key) via product-sdk hostLocalStorage
 *   - KvStore.remove(key) via product-sdk hostLocalStorage
 */
test.describe("@polkadot-apps/keys via Host API — session key lifecycle", () => {
    test("create generates mnemonic and derived addresses", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Click create
        await frame.locator('[data-testid="btn-create"]').click();

        // Wait for success in the log
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /create\(\) success/i,
            { timeout: 30_000 },
        );

        // Mnemonic should be a 12+ word phrase
        const mnemonic = await frame.locator('[data-testid="last-mnemonic"]').textContent();
        expect(mnemonic).toBeTruthy();
        const words = mnemonic!.trim().split(/\s+/);
        expect(words.length).toBeGreaterThanOrEqual(12);

        // SS58 address should be non-empty and not "-"
        const ss58 = await frame.locator('[data-testid="last-ss58"]').textContent();
        expect(ss58).toBeTruthy();
        expect(ss58!.trim()).not.toBe("-");

        // H160 address should start with "0x"
        const h160 = await frame.locator('[data-testid="last-h160"]').textContent();
        expect(h160).toBeTruthy();
        expect(h160!.trim().startsWith("0x")).toBe(true);
    });

    test("persistence round-trip through host storage", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Create a session key
        await frame.locator('[data-testid="btn-create"]').click();
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /create\(\) success/i,
            { timeout: 30_000 },
        );

        // Note the mnemonic
        const mnemonic1 = await frame.locator('[data-testid="last-mnemonic"]').textContent();
        expect(mnemonic1).toBeTruthy();

        // Get (should load the same key)
        await frame.locator('[data-testid="btn-get"]').click();
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /getOrCreate\(\) loaded/i,
            { timeout: 30_000 },
        );

        // Same mnemonic should be returned
        const mnemonic2 = await frame.locator('[data-testid="last-mnemonic"]').textContent();
        expect(mnemonic2).toBe(mnemonic1);
    });

    test("clear removes key, next get creates new one", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Create a session key
        await frame.locator('[data-testid="btn-create"]').click();
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /create\(\) success/i,
            { timeout: 30_000 },
        );

        // Note mnemonic1
        const mnemonic1 = await frame.locator('[data-testid="last-mnemonic"]').textContent();
        expect(mnemonic1).toBeTruthy();

        // Clear the key
        await frame.locator('[data-testid="btn-clear"]').click();
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /clear\(\) success/i,
            { timeout: 30_000 },
        );

        // Display should be reset
        await expect(frame.locator('[data-testid="last-mnemonic"]')).toHaveText("-");

        // Get should create a new key (different mnemonic)
        await frame.locator('[data-testid="btn-get"]').click();
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /getOrCreate\(\) created/i,
            { timeout: 30_000 },
        );

        const mnemonic2 = await frame.locator('[data-testid="last-mnemonic"]').textContent();
        expect(mnemonic2).toBeTruthy();
        expect(mnemonic2).not.toBe(mnemonic1);
    });

    test("host storage verification", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Create a session key
        await frame.locator('[data-testid="btn-create"]').click();
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /create\(\) success/i,
            { timeout: 30_000 },
        );

        // Read mnemonic from UI
        const mnemonic = await frame.locator('[data-testid="last-mnemonic"]').textContent();
        expect(mnemonic).toBeTruthy();

        // Verify the mnemonic is stored in the HOST page's localStorage with the test-host: prefix
        const storedValue = await testHost.page.evaluate(() =>
            localStorage.getItem("test-host:default"),
        );
        expect(storedValue).toBe(mnemonic!.trim());

        // Clear the key
        await frame.locator('[data-testid="btn-clear"]').click();
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /clear\(\) success/i,
            { timeout: 30_000 },
        );

        // Verify the key is removed from host storage
        const clearedValue = await testHost.page.evaluate(() =>
            localStorage.getItem("test-host:default"),
        );
        expect(clearedValue).toBeNull();
    });
});
