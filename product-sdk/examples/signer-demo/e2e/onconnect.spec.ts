import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — onConnect lifecycle hook", () => {
    test("fires once after connect and refires after reconnect", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        const status = frame.locator('[data-testid="onconnect-status"]');

        // Single fire on initial connect — gated on the transition, not on
        // every subscribe notification, so the count stays at 1× even after
        // selectAccount / state mutations.
        await expect(status).toContainText("fired (1×)", { timeout: 30_000 });

        // Permission result resolves to an `outcomes:` line once the test host
        // (≥ 0.7.4) replies to `host_request_resource_allocation`. The
        // `error:` branch is the fallback for older hosts that don't
        // implement the handler — keeping it future-proofs against host
        // regressions or environments running an older test SDK.
        const result = frame.locator('[data-testid="onconnect-result"]');
        await expect(result).toHaveText(/^(outcomes:|error:)/, { timeout: 10_000 });

        // Reconnect: disconnect + connect should fire onConnect a second time.
        await frame.locator('[data-testid="btn-reconnect"]').click();
        await expect(status).toContainText("fired (2×)", { timeout: 30_000 });
    });

    test("subscribe fires more often than onConnect — selectAccount doesn't refire onConnect", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        // Wait for the steady-state counts after connect to land.
        const onConnectCount = frame.locator('[data-testid="onconnect-count"]');
        const transitionCount = frame.locator('[data-testid="transition-count"]');
        const subscribeCount = frame.locator('[data-testid="subscribe-count"]');
        await expect(onConnectCount).toHaveText("1", { timeout: 30_000 });

        const subscribeBefore = parseInt((await subscribeCount.textContent()) ?? "0", 10);
        const transitionBefore = parseInt((await transitionCount.textContent()) ?? "0", 10);

        // Click an account row — subscribe fires (selectedAccount changes),
        // but neither status transition nor onConnect should advance.
        const rows = frame.locator('[data-testid="accounts-list"] .account-row');
        await rows.nth(1).click();

        // Subscribe count must strictly increase; transition + onConnect stay put.
        await expect
            .poll(async () => parseInt((await subscribeCount.textContent()) ?? "0", 10), {
                timeout: 5_000,
            })
            .toBeGreaterThan(subscribeBefore);
        expect(parseInt((await transitionCount.textContent()) ?? "0", 10)).toBe(transitionBefore);
        await expect(onConnectCount).toHaveText("1");
    });
});
