import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import { expect, type FrameLocator } from "@playwright/test";

/**
 * Wait for the demo app to fully boot inside the test host.
 *
 * Waits for:
 *   1. Host connection established
 *   2. Signer connected ("connected")
 *   3. Account address resolved (not "-")
 *   4. Upload/query strategies resolved (not "-")
 *   5. BulletinClient connected
 *   6. Upload button enabled
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

    // Strategies resolved
    await expect(frame.locator('[data-testid="upload-strategy"]')).not.toHaveText("-", { timeout });
    await expect(frame.locator('[data-testid="query-strategy"]')).not.toHaveText("-", { timeout });

    // BulletinClient connected to bulletin chain
    await expect(frame.locator('[data-testid="bulletin-status"]')).toHaveText("connected", {
        timeout,
    });

    // Controls enabled
    await expect(frame.locator('[data-testid="btn-upload"]')).toBeEnabled({ timeout });

    return frame;
}
