// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import { expect, type FrameLocator } from "@playwright/test";

/**
 * Wait for the nfts demo to finish its first read inside the test host.
 *
 * Waits for:
 *   1. Host connection established
 *   2. The chain client connected through the host
 *   3. `getClaimableCollections` reported a count — the app renders `-` until then
 */
export async function waitForAppReady(
    testHost: TestHost,
    options?: { timeout?: number },
): Promise<FrameLocator> {
    const timeout = options?.timeout ?? 90_000;
    const frame = testHost.productFrame();

    await testHost.waitForConnection(timeout);

    await frame.locator('[data-testid="app-heading"]').waitFor({ state: "visible", timeout });

    await expect(frame.locator('[data-testid="chain-status"]')).toHaveText("connected", {
        timeout,
    });
    await expect(frame.locator('[data-testid="registry-count"]')).not.toHaveText("-", { timeout });

    return frame;
}

/** A rendered numeric cell, failed loudly rather than coerced to NaN. */
export async function numberIn(frame: FrameLocator, testId: string): Promise<number> {
    const text = await frame.locator(`[data-testid="${testId}"]`).textContent();
    expect(text, `${testId} should render`).toBeTruthy();
    const value = Number(text!.trim());
    expect(Number.isFinite(value), `${testId} should be numeric, got "${text}"`).toBe(true);
    return value;
}
