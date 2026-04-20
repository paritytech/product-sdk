import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Publishing statements through the Host API path.
 *
 * Exercises:
 *   - StatementStoreClient.publish()
 *   - HostTransport.signAndSubmit() → sdkStatementToHost() → store.createProof() → store.submit()
 *   - Round-trip: submitted statement echoes back via subscription
 *
 * Host API surface tested:
 *   - store.createProof(accountId, statement)
 *   - store.submit(signedStatement)
 *   - Type conversion: sdkStatementToHost() (hex → Uint8Array)
 */
test.describe("@polkadot-apps/statement-store via Host API — publish", () => {
    test("publish succeeds via host signing and appears in submission log", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        // Click publish
        await frame.locator('[data-testid="btn-publish"]').click();

        // Wait for success log
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(
            /Published:/i,
            { timeout: 30_000 },
        );

        // Verify the host recorded the submission
        const submitted = await testHost.getSubmittedStatements();
        expect(submitted.length).toBeGreaterThanOrEqual(1);
        expect(submitted[0].timestamp).toBeGreaterThan(0);
    });

    test("published statement echoes back via subscription (full round-trip)", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        // Verify initial received count is 0
        await expect(frame.locator('[data-testid="received-count"]')).toHaveText("0");

        // Publish a statement
        await frame.locator('[data-testid="btn-publish"]').click();

        // Wait for success
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(
            /Published:/i,
            { timeout: 30_000 },
        );

        // The statement should echo back via subscription — received count increments.
        // This exercises the full round-trip:
        //   publish → sdkStatementToHost → createProof → submit → host delivers →
        //   hostSignedStatementToSdk → client callback
        await expect(frame.locator('[data-testid="received-count"]')).not.toHaveText("0", {
            timeout: 30_000,
        });

        const count = await frame.locator('[data-testid="received-count"]').textContent();
        expect(Number(count)).toBeGreaterThanOrEqual(1);

        // Log should show the received statement data
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(/Received #1/);
    });

    test("publish with topic2 includes secondary topic", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        // Click publish with topic2
        await frame.locator('[data-testid="btn-publish-topic2"]').click();

        // Wait for success
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(
            /Published \(topic2\):/i,
            { timeout: 30_000 },
        );

        // Verify the host recorded the submission
        const submitted = await testHost.getSubmittedStatements();
        expect(submitted.length).toBeGreaterThanOrEqual(1);

        // The submitted statement should have topics — verify it was actually sent
        const stmt = submitted[submitted.length - 1].statement as {
            topics?: unknown[];
        };
        // In host format, topics are Uint8Array[]. Should have at least 2 (appTopic + topic2)
        expect(stmt.topics).toBeDefined();
        expect(stmt.topics!.length).toBeGreaterThanOrEqual(2);
    });
});
