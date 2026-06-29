// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// TEMP DIAGNOSTIC — delete after use.
import { test } from "./fixtures";

test("diag: capture console + log during BYOD connect", async ({ testHost, page }) => {
    const lines: string[] = [];
    page.on("console", (m) => lines.push(`[console.${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));
    page.on("requestfailed", (r) =>
        lines.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`),
    );

    await testHost.waitForConnection(60_000);
    const frame = testHost.productFrame();
    await frame.locator('[data-testid="app-heading"]').waitFor({ state: "visible" });

    // Give the BYOD flow up to 60s to do whatever it's going to do.
    await page.waitForTimeout(60_000);

    const status = await frame.locator('[data-testid="byod-status"]').textContent();
    const log = await frame.locator('[data-testid="chain-client-log"]').textContent();

    console.log("\n========== BYOD STATUS ==========\n", status);
    console.log("\n========== DEMO LOG ==========\n", log);
    console.log("\n========== BROWSER CONSOLE ==========");
    for (const l of lines) console.log(l);
    console.log("========== END ==========\n");
});
