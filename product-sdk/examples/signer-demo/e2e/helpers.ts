import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import { expect, type FrameLocator } from "@playwright/test";

/**
 * Wait for signer-demo to finish its boot sequence inside the test host:
 *   1. Host ↔ product-sdk handshake complete.
 *   2. App heading visible.
 *   3. `SignerManager` has reached `"connected"` status, surfaced in the
 *      `connection-status` testid.
 *   4. At least one account has been auto-selected, surfaced in
 *      `selected-address`.
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
    await expect(frame.locator('[data-testid="selected-address"]')).not.toHaveText("-", {
        timeout,
    });
    return frame;
}
