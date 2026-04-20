import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import { expect, type FrameLocator } from "@playwright/test";

/**
 * Wait for the chain-client demo app to fully boot inside the test host.
 *
 * Waits for:
 *   1. Host connection established
 *   2. Signer connected ("connected")
 *   3. Account address resolved (not "-")
 *   4. Preset status = "connected"
 *   5. BYOD status = "connected"
 */
export async function waitForAppReady(
    testHost: TestHost,
    options?: { timeout?: number },
): Promise<FrameLocator> {
    const timeout = options?.timeout ?? 90_000;
    const frame = testHost.productFrame();

    await testHost.waitForConnection(timeout);

    await frame.locator('[data-testid="app-heading"]').waitFor({ state: "visible", timeout });

    await expect(frame.locator('[data-testid="connection-status"]')).toHaveText("connected", {
        timeout,
    });
    await expect(frame.locator('[data-testid="account-address"]')).not.toHaveText("-", { timeout });

    // Both preset and BYOD should be connected
    await expect(frame.locator('[data-testid="preset-status"]')).toHaveText("connected", {
        timeout,
    });
    await expect(frame.locator('[data-testid="byod-status"]')).toHaveText("connected", {
        timeout,
    });

    return frame;
}
