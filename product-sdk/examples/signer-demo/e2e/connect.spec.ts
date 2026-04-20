import { test, expect, SS58_PREFIX } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@polkadot-apps/signer — connect + subscribe", () => {
    test("boots through Host API, lists accounts, selects the first one", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        await expect(frame.locator('[data-testid="app-heading"]')).toBeVisible();
        await expect(frame.locator('[data-testid="active-provider"]')).toHaveText("host");

        // Auto-permission regression: if the fix shipped in signer 1.0.2 ever
        // regresses, the signing log will be empty but the state machine will
        // still report connected. The real assertion lives in sign-raw.spec.ts,
        // but we at least confirm connect() didn't throw.
        await expect(frame.locator('[data-testid="last-error"]')).toBeEmpty();

        // Exactly two accounts (Bob + Charlie) from the fixture.
        const rows = frame.locator('[data-testid="accounts-list"] .account-row');
        await expect(rows).toHaveCount(2);

        // Selected account starts with the Paseo Asset Hub SS58 prefix.
        const selected = frame.locator('[data-testid="selected-address"]');
        const text = await selected.textContent();
        expect(text).toBeTruthy();
        const expectedStart = SS58_PREFIX === 0 ? "1" : "5";
        expect(text!.startsWith(expectedStart)).toBe(true);

        // subscribe() should have emitted at least one "state:" line in the log.
        await expect(frame.locator('[data-testid="event-log"]')).toContainText(/state:\s+status=connected/);
    });
});
