import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import { expect, type FrameLocator } from "@playwright/test";

/**
 * Wait for the demo app to fully boot inside the test host.
 *
 * Waits for:
 *   1. Host connection established
 *   2. Signer connected ("connected")
 *   3. Account address resolved (not "-")
 *   4. StatementStoreClient connected ("connected")
 *   5. Controls enabled (publish button)
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

    // StatementStoreClient connected via HostTransport
    await expect(frame.locator('[data-testid="store-status"]')).toHaveText("connected", {
        timeout,
    });

    // Controls should be enabled (publish button not disabled)
    await expect(frame.locator('[data-testid="btn-publish"]')).toBeEnabled({ timeout });

    return frame;
}
