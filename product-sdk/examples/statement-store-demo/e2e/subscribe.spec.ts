import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Receiving statements through the Host API subscription path.
 *
 * Exercises:
 *   - HostTransport.subscribe() → store.subscribe(topics, callback)
 *   - hostSignedStatementToSdk() type conversion (Uint8Array → hex strings)
 *   - extractTopicBytes() topic conversion
 *   - Statement deduplication in StatementStoreClient
 *
 * Host API surface tested:
 *   - store.subscribe() — topic-filtered subscription
 *   - Type conversion: hostSignedStatementToSdk() (Uint8Array → hex)
 *   - Type conversion: extractTopicBytes() (hex → Uint8Array for host subscription)
 */
test.describe("@polkadot-apps/statement-store via Host API — subscribe", () => {
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

        // Inject a statement from the test side.
        // Must construct Uint8Arrays inside page.evaluate (Playwright can't
        // serialize Uint8Array / BigInt across the wire).
        await testHost.page.evaluate((topic: string) => {
            const fromHex = (h: string) => {
                const c = h.startsWith("0x") ? h.slice(2) : h;
                const b = new Uint8Array(c.length / 2);
                for (let i = 0; i < b.length; i++)
                    b[i] = parseInt(c.substring(i * 2, i * 2 + 2), 16);
                return b;
            };
            window.__TEST_HOST__.injectStatement({
                topics: [fromHex(topic)],
                data: new TextEncoder().encode(
                    JSON.stringify({ type: "injected", text: "from test", timestamp: Date.now() }),
                ),
                expiry: BigInt(Math.floor(Date.now() / 1000) + 60) << 32n,
                proof: {
                    tag: "Sr25519",
                    value: {
                        signature: new Uint8Array(64).fill(0xaa),
                        signer: new Uint8Array(32).fill(0xbb),
                    },
                },
            });
        }, topicHex!);

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
        await testHost.page.evaluate(() => {
            window.__TEST_HOST__.injectStatement({
                topics: [new Uint8Array(32).fill(0x00)],
                data: new TextEncoder().encode(
                    JSON.stringify({ type: "wrong-topic", timestamp: Date.now() }),
                ),
                expiry: BigInt(Math.floor(Date.now() / 1000) + 60) << 32n,
                proof: {
                    tag: "Sr25519",
                    value: {
                        signature: new Uint8Array(64).fill(0xaa),
                        signer: new Uint8Array(32).fill(0xbb),
                    },
                },
            });
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

        // Inject 3 statements with different channels (to avoid deduplication)
        for (let i = 1; i <= 3; i++) {
            await testHost.page.evaluate(
                ([topic, idx]: [string, number]) => {
                    const fromHex = (h: string) => {
                        const c = h.startsWith("0x") ? h.slice(2) : h;
                        const b = new Uint8Array(c.length / 2);
                        for (let j = 0; j < b.length; j++)
                            b[j] = parseInt(c.substring(j * 2, j * 2 + 2), 16);
                        return b;
                    };
                    // Use a unique channel per statement to bypass deduplication
                    const channel = new Uint8Array(32);
                    channel[0] = idx;
                    window.__TEST_HOST__.injectStatement({
                        topics: [fromHex(topic)],
                        channel,
                        data: new TextEncoder().encode(
                            JSON.stringify({
                                type: "multi",
                                index: idx,
                                timestamp: Date.now(),
                            }),
                        ),
                        expiry: BigInt(Math.floor(Date.now() / 1000) + 60 + idx) << 32n,
                        proof: {
                            tag: "Sr25519",
                            value: {
                                signature: new Uint8Array(64).fill(0xaa),
                                signer: new Uint8Array(32).fill(0xbb),
                            },
                        },
                    });
                },
                [topicHex!, i] as [string, number],
            );
        }

        // Wait for all 3 to arrive
        await expect(frame.locator('[data-testid="received-count"]')).toHaveText("3", {
            timeout: 30_000,
        });
    });
});
