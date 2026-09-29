// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Receiving statements through the Host API subscription path.
 *
 * Exercises:
 *   - HostTransport.subscribe() → store.subscribe(topics, callback), topic-filtered
 *   - hostSignedStatementToSdk() (hex → Uint8Array)
 */
/** UTF-8 → `0x`-hex, for `StatementInput.data`. */
const toHexData = (value: string): `0x${string}` =>
    `0x${Array.from(new TextEncoder().encode(value), (b) => b.toString(16).padStart(2, "0")).join("")}`;

test.describe("@parity/product-sdk-statement-store via Host API — subscribe", () => {
    test("injected statement arrives via subscription", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        // Verify initial received count is 0
        await expect(frame.locator('[data-testid="received-count"]')).toHaveText("0");

        // Read the app's topic hex from the product — needed so the injected
        // statement matches the subscriber's topic filter.
        const topicHex = await frame.locator('[data-testid="app-topic-hex"]').textContent();
        expect(topicHex).toBeTruthy();
        expect(topicHex!.startsWith("0x")).toBe(true);

        // `injectStatement` signs with the active session identity, so nothing
        // needs constructing inside the page.
        await testHost.injectStatement({
            topics: [topicHex! as `0x${string}`],
            data: toHexData(
                JSON.stringify({ type: "injected", text: "from test", timestamp: Date.now() }),
            ),
        });

        // Wait for the app to receive the injected statement
        await expect(frame.locator('[data-testid="received-count"]')).not.toHaveText("0", {
            timeout: 30_000,
        });

        // Log should show the received data
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(/Received #1/);
        await expect(frame.locator('[data-testid="statement-log"]')).toContainText(/injected/);
    });

    test("statement with non-matching topic is not delivered", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        await expect(frame.locator('[data-testid="received-count"]')).toHaveText("0");

        // Inject a statement with a DIFFERENT topic (all zeros — won't match app topic)
        await testHost.injectStatement({
            topics: [`0x${"00".repeat(32)}`],
            data: toHexData(JSON.stringify({ type: "wrong-topic", timestamp: Date.now() })),
        });

        // Negative test: we're verifying something does NOT happen, so there's no
        // positive signal to wait for. A time-bounded wait is the only option.
        await frame.locator('[data-testid="statement-log"]').waitFor({ state: "visible" });
        await testHost.page.waitForTimeout(3000);

        // Received count should still be 0 — the wrong-topic statement was filtered out
        await expect(frame.locator('[data-testid="received-count"]')).toHaveText("0");
    });

    test("multiple injected statements all arrive", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearStatements();

        await expect(frame.locator('[data-testid="received-count"]')).toHaveText("0");

        const topicHex = await frame.locator('[data-testid="app-topic-hex"]').textContent();

        // Payloads differ by `index`: with no `channel` field, the dedupe key is
        // a hash of `data`.
        for (let i = 1; i <= 3; i++) {
            await testHost.injectStatement({
                topics: [topicHex! as `0x${string}`],
                data: toHexData(
                    JSON.stringify({ type: "multi", index: i, timestamp: Date.now() }),
                ),
            });
        }

        // Wait for all 3 to arrive
        await expect(frame.locator('[data-testid="received-count"]')).toHaveText("3", {
            timeout: 30_000,
        });
    });
});
