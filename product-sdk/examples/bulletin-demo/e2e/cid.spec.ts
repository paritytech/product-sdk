import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * CID computation and preimage-key consistency.
 *
 * Verifies that:
 *   - computeCid() produces valid CIDv1 strings
 *   - cidToPreimageKey(computeCid(data)) matches the host's blake2b-256 key
 *   - The host and product use the same hashing for round-trip consistency
 *
 * Surface tested:
 *   - computeCid(), cidToPreimageKey() — verified against real host preimage keys
 */
test.describe("@polkadot-apps/bulletin via Host API — CID", () => {
    test("computeCid produces valid CIDv1 string", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Upload to get a CID
        await frame.locator('[data-testid="btn-upload"]').click();
        await expect(frame.locator('[data-testid="bulletin-log"]')).toContainText(
            /Uploaded \(preimage\):/i,
            { timeout: 30_000 },
        );

        const cid = await frame.locator('[data-testid="last-cid"]').textContent();
        expect(cid).toBeTruthy();
        // CIDv1 strings start with a multibase prefix (typically 'b' for base32)
        expect(cid!.length).toBeGreaterThan(10);
    });

    test("CID-to-preimage-key matches host's blake2b-256 key", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearPreimages();

        // Seed the same data as the default upload input
        const testData = new TextEncoder().encode("hello from bulletin-demo");
        const seededKey = await testHost.seedPreimage(testData);

        // Compute CID → preimage key via the product's utility functions
        const derivedKey = await frame.locator("body").evaluate((_, dataArr) => {
            const b = (window as unknown as Record<string, unknown>).__BULLETIN__ as {
                computeCid: (data: Uint8Array) => string;
                cidToPreimageKey: (cid: string) => string;
            };
            const cid = b.computeCid(new Uint8Array(dataArr));
            return b.cidToPreimageKey(cid);
        }, Array.from(testData));

        // The host's blake2b-256 key should match cidToPreimageKey(computeCid(data))
        expect(derivedKey.toLowerCase()).toBe(seededKey.toLowerCase());
    });
});
