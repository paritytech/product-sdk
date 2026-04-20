import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import { expect, type FrameLocator } from "@playwright/test";

/**
 * Wait for the demo app to fully boot inside the test host.
 *
 * Waits for:
 *   1. Host connection established
 *   2. Signer connected ("connected")
 *   3. Account address resolved (not "-")
 *   4. Session status = "ready"
 *   5. Controls enabled (create button)
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

    // Session key manager should be ready
    await expect(frame.locator('[data-testid="session-status"]')).toHaveText("ready", {
        timeout,
    });

    // Controls should be enabled (create button not disabled)
    await expect(frame.locator('[data-testid="btn-create"]')).toBeEnabled({ timeout });

    return frame;
}
