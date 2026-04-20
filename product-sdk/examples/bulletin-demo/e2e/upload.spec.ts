import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Upload via the host preimage path.
 *
 * Exercises:
 *   - BulletinClient.upload() → resolveUploadStrategy() → preimage
 *   - preimageManager.submit(data) → host stores with blake2b-256 key
 *   - computeCid() → cidToPreimageKey() → key consistency
 *
 * Host API surface tested:
 *   - preimageManager.submit(data: Uint8Array): Promise<string>
 */
test.describe("@polkadot-apps/bulletin via Host API — upload", () => {
    test("upload stores preimage on host", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearPreimages();

        // Click upload
        await frame.locator('[data-testid="btn-upload"]').click();

        // Wait for success log
        await expect(frame.locator('[data-testid="bulletin-log"]')).toContainText(
            /Uploaded \(preimage\):/i,
            { timeout: 30_000 },
        );

        // CID and preimage key should be populated
        const cid = await frame.locator('[data-testid="last-cid"]').textContent();
        expect(cid).toBeTruthy();
        expect(cid).not.toBe("-");

        const preimageKey = await frame.locator('[data-testid="last-preimage-key"]').textContent();
        expect(preimageKey).toBeTruthy();
        expect(preimageKey).not.toBe("-");
        expect(preimageKey!.startsWith("0x")).toBe(true);

        // Verify the host recorded the preimage
        const preimages = await testHost.getPreimages();
        expect(preimages.length).toBeGreaterThanOrEqual(1);

        // Find the entry submitted by the product
        const fromProduct = preimages.filter((p) => p.fromProduct);
        expect(fromProduct.length).toBeGreaterThanOrEqual(1);
        expect(fromProduct[0].key).toBeTruthy();
    });

    test("uploaded preimage key matches CID derivation", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearPreimages();

        await frame.locator('[data-testid="btn-upload"]').click();
        await expect(frame.locator('[data-testid="bulletin-log"]')).toContainText(
            /Uploaded \(preimage\):/i,
            { timeout: 30_000 },
        );

        // Read CID and preimage key from UI
        const cid = await frame.locator('[data-testid="last-cid"]').textContent();
        const preimageKey = await frame.locator('[data-testid="last-preimage-key"]').textContent();

        // Compute expected key from CID via the app's exposed utilities
        const expectedKey = await frame.locator("body").evaluate((_, cidStr) => {
            const b = (window as unknown as Record<string, unknown>).__BULLETIN__ as {
                cidToPreimageKey: (cid: string) => string;
            };
            return b.cidToPreimageKey(cidStr);
        }, cid!);

        // The host's returned key should match cidToPreimageKey(cid)
        expect(preimageKey!.toLowerCase()).toBe(expectedKey.toLowerCase());
    });

    test("multiple uploads create multiple preimage entries", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearPreimages();

        const logLoc = frame.locator('[data-testid="bulletin-log"]');

        // First upload
        await frame.locator('[data-testid="upload-input"]').fill("first-upload");
        await frame.locator('[data-testid="btn-upload"]').click();

        // Wait for first upload to complete — log contains "first-upload" in uploading line
        // and at least one "Uploaded (preimage):" success line.
        await expect(logLoc).toContainText(/Uploaded \(preimage\):/, { timeout: 30_000 });
        await expect(frame.locator('[data-testid="btn-upload"]')).toBeEnabled({ timeout: 10_000 });

        const firstCid = await frame.locator('[data-testid="last-cid"]').textContent();

        // Second upload with different data
        await frame.locator('[data-testid="upload-input"]').fill("second-upload");
        await frame.locator('[data-testid="btn-upload"]').click();

        // Wait for second upload to complete — the log will contain two "Uploaded" lines.
        // The preimage path resolves nearly instantly (in-memory in the test host),
        // so the button's disabled state is too transient for toBeDisabled() to observe.
        await expect(logLoc.locator(':text("Uploaded (preimage):")')).toHaveCount(2, {
            timeout: 30_000,
        });
        await expect(frame.locator('[data-testid="btn-upload"]')).toBeEnabled({ timeout: 10_000 });

        // Verify CID changed (different data → different CID)
        const secondCid = await frame.locator('[data-testid="last-cid"]').textContent();
        expect(secondCid).not.toBe(firstCid);

        // Verify the host has 2 preimage entries from the product
        const preimages = await testHost.getPreimages();
        const fromProduct = preimages.filter((p) => p.fromProduct);
        expect(fromProduct.length).toBeGreaterThanOrEqual(2);

        // They should have different keys
        const keys = fromProduct.map((p) => p.key);
        expect(new Set(keys).size).toBeGreaterThanOrEqual(2);
    });
});
