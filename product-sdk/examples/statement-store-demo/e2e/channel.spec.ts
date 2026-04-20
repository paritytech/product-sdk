import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * ChannelStore operations through the Host API path.
 *
 * Exercises the full round-trip:
 *   ChannelStore.write() → client.publish() → HostTransport.signAndSubmit() →
 *   store.createProof() → store.submit() → host delivers via subscription →
 *   hostSignedStatementToSdk() → client callback → ChannelStore.handleStatement() →
 *   ChannelStore.updateChannel() → onChange()
 *
 * Host API surface tested:
 *   - store.createProof() — proof creation for channel writes
 *   - store.submit() — channel statement submission
 *   - store.subscribe() — channel echoes arrive via subscription
 *   - Full type conversion round-trip through host ↔ sdk bridge
 */
test.describe("@polkadot-apps/statement-store via Host API — ChannelStore", () => {
    test("channel write round-trip updates channel value", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        // Initial state
        await expect(frame.locator('[data-testid="channel-count"]')).toHaveText("0");
        await expect(frame.locator('[data-testid="channel-value"]')).toHaveText("-");

        // Click channel write
        await frame.locator('[data-testid="btn-channel-write"]').click();

        // Wait for success log
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(
            /Channel write:/i,
            { timeout: 30_000 },
        );

        // Channel count should be 1 (local write updates immediately)
        await expect(frame.locator('[data-testid="channel-count"]')).toHaveText("1", {
            timeout: 10_000,
        });

        // Channel value should contain the written data
        const value = await frame.locator('[data-testid="channel-value"]').textContent();
        expect(value).toBeTruthy();
        expect(value).not.toBe("-");

        // Verify the data was actually submitted to the host
        const submitted = await testHost.getSubmittedStatements();
        expect(submitted.length).toBeGreaterThanOrEqual(1);
    });

    test("last-write-wins: second write to same channel replaces first", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        // First write
        await frame.locator('[data-testid="channel-input"]').fill("first-value");
        await frame.locator('[data-testid="btn-channel-write"]').click();
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(
            /Channel write: "first-value"/i,
            { timeout: 30_000 },
        );

        // Wait for first write to complete
        await expect(frame.locator('[data-testid="channel-count"]')).toHaveText("1", {
            timeout: 10_000,
        });

        // Second write to same channel
        await frame.locator('[data-testid="channel-input"]').fill("second-value");
        await frame.locator('[data-testid="btn-channel-write"]').click();
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(
            /Channel write: "second-value"/i,
            { timeout: 30_000 },
        );

        // Should still be 1 channel (same channel name, not a new one)
        await expect(frame.locator('[data-testid="channel-count"]')).toHaveText("1", {
            timeout: 10_000,
        });

        // Value should be the second write (last-write-wins)
        const value = await frame.locator('[data-testid="channel-value"]').textContent();
        expect(value).toContain("second-value");
    });

    test("multiple channels are tracked independently", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        // Write to channel "test-channel" via the UI button
        await frame.locator('[data-testid="channel-input"]').fill("value-1");
        await frame.locator('[data-testid="btn-channel-write"]').click();
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(
            /Channel write: "value-1"/i,
            { timeout: 30_000 },
        );

        await expect(frame.locator('[data-testid="channel-count"]')).toHaveText("1", {
            timeout: 10_000,
        });

        // Write to a DIFFERENT channel name via the exposed window.__CHANNELS__.
        // Use locator('body').evaluate() to run inside the product iframe context.
        await frame.locator("body").evaluate(async () => {
            const channels = (window as unknown as Record<string, unknown>).__CHANNELS__ as {
                write: (name: string, value: unknown) => Promise<boolean>;
            };
            await channels.write("second-channel", {
                type: "presence",
                value: "value-2",
                timestamp: Date.now(),
            });
        });

        // Wait for the second channel to register
        await expect(frame.locator('[data-testid="channel-count"]')).toHaveText("2", {
            timeout: 30_000,
        });

        // Verify the host recorded submissions for both channels
        const submitted = await testHost.getSubmittedStatements();
        expect(submitted.length).toBeGreaterThanOrEqual(2);
    });
});
