import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Query via the host preimage lookup path.
 *
 * Exercises:
 *   - BulletinClient.fetchBytes() → resolveQueryStrategy() → host-lookup
 *   - lookupViaHost() → preimageManager.lookup(key, callback)
 *   - Subscription-to-Promise conversion with timeout
 *   - Full round-trip: upload → host stores → query → host returns
 *
 * Host API surface tested:
 *   - preimageManager.lookup(key, callback) → subscription-based API
 */
test.describe("@polkadot-apps/bulletin via Host API — query", () => {
    test("seeded preimage is found via host lookup", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearPreimages();

        // Seed a preimage from the test side — the host stores it and
        // returns its blake2b-256 hex key.
        const testData = new TextEncoder().encode("seeded-data-from-test");
        const seededKey = await testHost.seedPreimage(testData);
        expect(seededKey).toBeTruthy();
        expect(seededKey.startsWith("0x")).toBe(true);

        // Compute the CID that corresponds to this data, using the app's
        // exposed computeCid utility (runs inside the product iframe).
        const cid = await frame.locator("body").evaluate((_, dataArr) => {
            const b = (window as unknown as Record<string, unknown>).__BULLETIN__ as {
                computeCid: (data: Uint8Array) => string;
            };
            return b.computeCid(new Uint8Array(dataArr));
        }, Array.from(testData));

        // Fill the CID input and click query
        await frame.locator('[data-testid="query-cid-input"]').fill(cid);
        await frame.locator('[data-testid="btn-query"]').click();

        // Wait for query result
        await expect(frame.locator('[data-testid="bulletin-log"]')).toContainText(
            /Query result.*seeded-data-from-test/i,
            { timeout: 30_000 },
        );

        // Verify the result matches
        const result = await frame.locator('[data-testid="query-result"]').textContent();
        expect(result).toBe("seeded-data-from-test");
    });

    test("upload-then-query round-trip", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearPreimages();

        // Upload data
        await frame.locator('[data-testid="upload-input"]').fill("round-trip-test");
        await frame.locator('[data-testid="btn-upload"]').click();
        await expect(frame.locator('[data-testid="bulletin-log"]')).toContainText(
            /Uploaded \(preimage\):/i,
            { timeout: 30_000 },
        );

        // CID should be auto-filled in the query input
        const cid = await frame.locator('[data-testid="last-cid"]').textContent();
        expect(cid).toBeTruthy();
        expect(cid).not.toBe("-");

        // Wait for button to re-enable, then query
        await expect(frame.locator('[data-testid="btn-query"]')).toBeEnabled({ timeout: 10_000 });
        await frame.locator('[data-testid="btn-query"]').click();

        // Wait for query result
        await expect(frame.locator('[data-testid="bulletin-log"]')).toContainText(
            /Query result.*round-trip-test/i,
            { timeout: 30_000 },
        );

        // Verify the retrieved data matches what was uploaded
        const result = await frame.locator('[data-testid="query-result"]').textContent();
        expect(result).toBe("round-trip-test");
    });
});
