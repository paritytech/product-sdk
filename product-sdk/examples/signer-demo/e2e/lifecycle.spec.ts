import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@polkadot-apps/signer — disconnect + reconnect", () => {
    test("disconnect resets state; manual reconnect restores account + provider", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);

        const initialAddr = await frame
            .locator('[data-testid="selected-address"]')
            .textContent();
        expect(initialAddr).toBeTruthy();

        // Click Disconnect. The subscribe callback should fire with the
        // post-disconnect state, which renders selected-address as "-"
        // and flips connection-status to "disconnected".
        await frame.locator('[data-testid="btn-disconnect"]').click();
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText(
            "disconnected",
        );
        await expect(frame.locator('[data-testid="selected-address"]')).toHaveText("-");

        // Sign button must be disabled during the disconnected state.
        await expect(frame.locator('[data-testid="btn-sign-raw"]')).toBeDisabled();

        // Click Reconnect (which is disconnect + connect). After it resolves,
        // the manager must end up back in "connected" with an account
        // auto-selected and the signer usable.
        await frame.locator('[data-testid="btn-reconnect"]').click();
        await expect(frame.locator('[data-testid="connection-status"]')).toHaveText(
            "connected",
            { timeout: 30_000 },
        );
        await expect(frame.locator('[data-testid="selected-address"]')).not.toHaveText("-");
        await expect(frame.locator('[data-testid="btn-sign-raw"]')).toBeEnabled();

        // Most importantly: the sign flow still works after the round-trip.
        // If reconnect leaked a stale provider reference, signRaw would fail.
        await testHost.clearSigningLog();
        await frame.locator('[data-testid="raw-input"]').fill("post-reconnect");
        await frame.locator('[data-testid="btn-sign-raw"]').click();
        await expect(frame.locator('[data-testid="last-signature"]')).toHaveText(
            /^0x[0-9a-f]+$/i,
            { timeout: 30_000 },
        );
        const log = await testHost.getSigningLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe("raw");
    });
});
