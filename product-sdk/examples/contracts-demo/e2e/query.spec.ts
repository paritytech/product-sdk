// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";

import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers `contract.method.query()` — the dry-run (read-only) path in
 * `@parity/product-sdk-contracts`.
 *
 * The three tests are the live-chain counterpart to the
 * `wrapContract — PAPI 2.x boundary` integration tests in `wrap.ts`.
 *
 * They feed the contract a freshly-randomised `bytes32` shopKey
 * (generated per test-run, guaranteed never-before-written) and assert
 * the decoded return value. Together they exercise every leg of the
 * boundary:
 *   - viem encoding the `bytes32` arg into the calldata,
 *   - the calldata flowing as a `Uint8Array` through PAPI's
 *     `ReviveApi.call`,
 *   - the chain's response coming back as a `Uint8Array`,
 *   - viem decoding three different ABI return shapes (uint256,
 *     string[], string).
 *
 * If the SDK ever regresses to passing class-based `Binary` /
 * `FixedSizeBinary` instances again, every one of these will fail
 * with `Incompatible runtime entry RuntimeCall(ReviveApi_call)`
 * before the response decode is even reached — i.e. these are the
 * canary that turns red the moment the version skew comes back.
 *
 * Why randomise the shopKey: Paseo v2 is a public testnet with
 * permanent state. An earlier version of this suite used the zero
 * shopKey, which collided with submit.spec.ts's write (also zero at
 * the time) and produced flaky "expected 0, got 1" failures after the
 * first run. A fresh 32 random bytes per test-run is vanishingly
 * unlikely to have ever been written to, so the deterministic empties
 * (`uint256 0`, `string[] []`, `string ""`) hold regardless of the
 * chain's accumulated history.
 */
const FRESH_SHOP_KEY = ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;

// TODO(contracts-demo-redeploy): the @t3rminal/bulletin-index contract at
// 0xD35CFc6E9F07B42Cc524A9Fa4A001F6ac90586E2 no longer exists on Paseo Asset
// Hub — it was reaped in the genesis reset (see the "re-pin paseo chains after
// genesis reset" descriptor bump). A ReviveApi.call dry-run to that address now
// returns success:true with flags:0 and empty (0-byte) output data and 0 gas,
// which the SDK correctly decodes to `undefined`, so these deterministic-empty
// assertions (uint256 0, string[] [], string "") fail. This is stale chain
// state, not an SDK regression: the wrap.ts "PAPI 2.x boundary" unit tests that
// cover this exact decode all pass. Re-enable once the contract is redeployed
// and the address + cdm.json are updated. Tracking: #322
test.describe.skip("@parity/product-sdk-contracts via Host API — query", () => {
    test("getReportCount(fresh shopKey) decodes uint256 → 0 (deterministic)", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="query-shopkey-input"]').fill(FRESH_SHOP_KEY);
        await frame.locator('[data-testid="btn-query-report-count"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');
        // The contract has never seen this freshly-randomised shopKey, so
        // the count must be exactly 0. The word boundary anchors the digit
        // so e.g. 10 or 100 wouldn't slip through.
        await expect(logLoc).toContainText(/reportCount: 0\b/, { timeout: 30_000 });

        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });

    test("getAllDates(fresh shopKey) decodes string[] → [] (deterministic)", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="query-shopkey-input"]').fill(FRESH_SHOP_KEY);
        await frame.locator('[data-testid="btn-query-all-dates"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');
        // viem decodes a Solidity `string[]` to a JS array — for an
        // unknown shopKey, exactly the empty array `[]`. The demo logs
        // it as `allDates: []` via `JSON.stringify`.
        await expect(logLoc).toContainText("allDates: []", { timeout: 30_000 });

        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });

    test("getCID(fresh shopKey, date) decodes string → \"\" (deterministic)", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="query-shopkey-input"]').fill(FRESH_SHOP_KEY);
        await frame.locator('[data-testid="report-date-input"]').fill("2099-12-31");
        await frame.locator('[data-testid="btn-query-cid"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');
        // No CID stored for this (shopKey, date) — viem decodes the
        // empty string return as `""`. The demo logs `cid: ""` via
        // JSON.stringify.
        await expect(logLoc).toContainText('cid: ""', { timeout: 30_000 });

        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });
});
