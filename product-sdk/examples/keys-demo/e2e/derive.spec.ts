import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

const KNOWN_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ALT_MNEMONIC =
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

/**
 * Mnemonic derivation through the Host API path.
 *
 * Exercises:
 *   - SessionKeyManager.fromMnemonic() — deterministic key derivation
 *   - Different mnemonics produce different addresses
 *   - Invalid mnemonic handling
 *
 * Host API surface tested:
 *   - None directly (fromMnemonic is pure/synchronous), but the test host
 *     environment is still required for the app to boot.
 */
test.describe("@polkadot-apps/keys via Host API — derivation", () => {
    test("deterministic derivation from known mnemonic", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Fill the known mnemonic and derive
        await frame.locator('[data-testid="mnemonic-input"]').fill(KNOWN_MNEMONIC);
        await frame.locator('[data-testid="btn-derive"]').click();

        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /fromMnemonic\(\) success/i,
            { timeout: 30_000 },
        );

        // SS58 address should be valid (not "-", not "error")
        const ss58_1 = await frame.locator('[data-testid="last-ss58"]').textContent();
        expect(ss58_1).toBeTruthy();
        expect(ss58_1!.trim()).not.toBe("-");
        expect(ss58_1!.trim()).not.toBe("error");

        // H160 address should start with "0x"
        const h160_1 = await frame.locator('[data-testid="last-h160"]').textContent();
        expect(h160_1).toBeTruthy();
        expect(h160_1!.trim().startsWith("0x")).toBe(true);

        // Derive again with the same mnemonic — should produce the same addresses
        await frame.locator('[data-testid="mnemonic-input"]').fill(KNOWN_MNEMONIC);
        await frame.locator('[data-testid="btn-derive"]').click();

        const ss58_2 = await frame.locator('[data-testid="last-ss58"]').textContent();
        const h160_2 = await frame.locator('[data-testid="last-h160"]').textContent();

        expect(ss58_2).toBe(ss58_1);
        expect(h160_2).toBe(h160_1);
    });

    test("different mnemonics produce different addresses", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Derive with the known mnemonic
        await frame.locator('[data-testid="mnemonic-input"]').fill(KNOWN_MNEMONIC);
        await frame.locator('[data-testid="btn-derive"]').click();

        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /fromMnemonic\(\) success/i,
            { timeout: 30_000 },
        );

        const ss58_1 = await frame.locator('[data-testid="last-ss58"]').textContent();
        expect(ss58_1).toBeTruthy();

        // Derive with a different mnemonic
        await frame.locator('[data-testid="mnemonic-input"]').fill(ALT_MNEMONIC);
        await frame.locator('[data-testid="btn-derive"]').click();

        // Wait for the second derivation to complete
        // The log should now contain two success messages; wait for the SS58 to change
        const ss58Locator = frame.locator('[data-testid="last-ss58"]');
        await expect(ss58Locator).not.toHaveText(ss58_1!.trim(), { timeout: 30_000 });

        const ss58_2 = await ss58Locator.textContent();
        expect(ss58_2).toBeTruthy();
        expect(ss58_2!.trim()).not.toBe("-");
        expect(ss58_2!.trim()).not.toBe("error");
        expect(ss58_2).not.toBe(ss58_1);
    });

    test("invalid mnemonic shows error", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        // Fill an invalid mnemonic
        await frame.locator('[data-testid="mnemonic-input"]').fill(
            "not a valid mnemonic phrase at all",
        );
        await frame.locator('[data-testid="btn-derive"]').click();

        // Log should contain an error about invalid mnemonic
        await expect(frame.locator('[data-testid="keys-log"]')).toContainText(
            /fromMnemonic\(\) failed/i,
            { timeout: 30_000 },
        );

        // SS58 should show "error"
        await expect(frame.locator('[data-testid="last-ss58"]')).toHaveText("error");
    });
});
