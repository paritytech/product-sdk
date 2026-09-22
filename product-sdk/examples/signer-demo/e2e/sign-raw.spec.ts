// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

test.describe("@parity/product-sdk-signer — signRaw", () => {
    test("returns a hex signature", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);

        await frame.locator('[data-testid="raw-input"]').fill("e2e-signer-demo");
        await frame.locator('[data-testid="btn-sign-raw"]').click();

        // Signature hex appears (66 chars = 2 for "0x" + 64-byte sr25519).
        const sigLoc = frame.locator('[data-testid="last-signature"]');
        await expect(sigLoc).toHaveText(/^0x[0-9a-f]+$/i, { timeout: 30_000 });
        const sig = await sigLoc.textContent();
        expect(sig!.length).toBeGreaterThan(2);

        // Button re-enables after the promise resolves.
        await expect(frame.locator('[data-testid="btn-sign-raw"]')).toBeEnabled();
    });

    // TODO(test-sdk-observability): host-api-test-sdk 0.14.0 records no
    // evidence of this signRaw() call anywhere. Diagnosed via the Step 3
    // probe (Task 5b, see task-5b-report.md): with getSigningLog(),
    // getUserConfirmationLog() and getPermissionLog() all cleared right
    // before the sign, then dumped right after a signRaw() call that
    // demonstrably succeeds (the product UI renders a valid hex signature,
    // see the test above), all three come back empty — []. This is not a
    // shape mismatch (SigningLogEntry is unchanged) and not the
    // auto-sign-vs-confirm split the original plan hypothesized (that would
    // show up in getUserConfirmationLog(), and it doesn't either). No
    // documented accessor currently carries "the host received a raw sign
    // request." Needs a tracking issue filed against
    // @parity/host-api-test-sdk; re-enable once an accessor surfaces it.
    test.skip(
        "the host records the raw sign request in the signing log",
        async ({ testHost }) => {
            const frame = await waitForAppReady(testHost);
            await testHost.clearSigningLog();

            await frame.locator('[data-testid="raw-input"]').fill("e2e-signer-demo");
            await frame.locator('[data-testid="btn-sign-raw"]').click();
            await expect(frame.locator('[data-testid="last-signature"]')).toHaveText(
                /^0x[0-9a-f]+$/i,
                { timeout: 30_000 },
            );

            const log = await testHost.getSigningLog();
            expect(log).toHaveLength(1);
            expect(log[0].type).toBe("raw");
        },
    );
});
