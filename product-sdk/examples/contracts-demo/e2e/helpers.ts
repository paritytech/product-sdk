// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import { expect, type FrameLocator } from "@playwright/test";

/**
 * Wait for the contracts-demo app to be fully ready inside the test host iframe:
 *   1. Host ↔ product-sdk connection established.
 *   2. App heading rendered.
 *   3. SignerManager reports "connected" and a product account is populated
 *      via `manager.getProductAccount("contracts-demo.dot", 0)`.
 *   4. ContractManager initialised — all action buttons are enabled.
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

    // ContractManager ready → action buttons enabled
    await expect(frame.locator('[data-testid="btn-query-report-count"]')).toBeEnabled({ timeout });
    await expect(frame.locator('[data-testid="btn-query-all-dates"]')).toBeEnabled({ timeout });
    await expect(frame.locator('[data-testid="btn-query-cid"]')).toBeEnabled({ timeout });
    await expect(frame.locator('[data-testid="btn-store-report"]')).toBeEnabled({ timeout });

    return frame;
}
