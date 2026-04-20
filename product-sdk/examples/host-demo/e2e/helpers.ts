import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import { expect, type FrameLocator } from "@playwright/test";

/**
 * Wait for the demo app to fully boot inside the test host.
 *
 * Waits for:
 *   1. Host connection established
 *   2. Signer connected ("connected")
 *   3. Account address resolved (not "-")
 *   4. Host storage available ("available")
 *   5. Controls enabled (write-string button)
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

    // Host storage should be available inside the test host
    await expect(frame.locator('[data-testid="host-storage-status"]')).toHaveText("available", {
        timeout,
    });

    // Controls should be enabled (write-string button not disabled)
    await expect(frame.locator('[data-testid="btn-write-string"]')).toBeEnabled({ timeout });

    return frame;
}
