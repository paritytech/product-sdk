import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * Covers `contract.method.query()` — the dry-run (read-only) path in
 * `@parity/product-sdk-contracts`.
 *
 * `owner()` on the t3rminal bulletin-index contract is a zero-arg view
 * function that returns the deployer's H160 address. It exercises:
 *   - The full RPC path through the host's chainConnection handler.
 *   - `ContractManager.getContract().owner.query()` resolution.
 *   - No signing is involved — proves queries work independently.
 *
 * The owner address is stable (deployer set at construction), so the
 * assertion is a simple non-null, non-error check.
 */
// TODO(contract-redeploy): Unskip once `@t3rminal/bulletin-index` is redeployed
// on paseo v2 and `examples/contracts-demo/src/cdm.json` is updated with the new
// address. Today the cdm.json points at the v1 deployment address (0xA2E388…),
// which has no code on v2, so every query returns `undefined`.
test.describe.skip("@parity/product-sdk-contracts via Host API — query", () => {
    test("owner() dry-run returns a hex address without signing", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame.locator('[data-testid="btn-query-owner"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');

        // The result is an H160 address (0x...)
        await expect(logLoc).toContainText(/owner: 0x[0-9a-fA-F]{40}/i, { timeout: 30_000 });

        // No signing should have occurred — query is a pure dry-run
        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });

    /**
     * The next three tests are the live-chain counterpart to the new
     * `wrapContract — PAPI 2.x boundary` integration tests in `wrap.ts`.
     *
     * They feed the contract a live `address` argument (the zero address,
     * for deterministic empty results) and assert the decoded return value.
     * Together they exercise every leg of the boundary:
     *   - viem encoding `HexString` address args into the calldata,
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
     */
    test("getReportCount(zero address) decodes uint256 → 0 (deterministic)", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame
            .locator('[data-testid="query-shop-input"]')
            .fill("0x0000000000000000000000000000000000000000");
        await frame.locator('[data-testid="btn-query-report-count"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');
        // The contract has never seen the zero address, so the count must
        // be exactly 0. The word boundary anchors the digit so e.g. 10
        // or 100 wouldn't slip through.
        await expect(logLoc).toContainText(/reportCount: 0\b/, { timeout: 30_000 });

        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });

    test("getAllDates(zero address) decodes string[] → [] (deterministic)", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame
            .locator('[data-testid="query-shop-input"]')
            .fill("0x0000000000000000000000000000000000000000");
        await frame.locator('[data-testid="btn-query-all-dates"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');
        // viem decodes a Solidity `string[]` to a JS array — for an
        // unknown shop, exactly the empty array `[]`. The demo logs it
        // as `allDates: []` via `JSON.stringify`.
        await expect(logLoc).toContainText("allDates: []", { timeout: 30_000 });

        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });

    test("getCID(zero address, date) decodes string → \"\" (deterministic)", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost);
        await testHost.clearSigningLog();

        await frame
            .locator('[data-testid="query-shop-input"]')
            .fill("0x0000000000000000000000000000000000000000");
        await frame.locator('[data-testid="report-date-input"]').fill("2099-12-31");
        await frame.locator('[data-testid="btn-query-cid"]').click();

        const logLoc = frame.locator('[data-testid="contract-log"]');
        // No CID stored for this (shop, date) — viem decodes the empty
        // string return as `""`. The demo logs `cid: ""` via JSON.stringify.
        await expect(logLoc).toContainText('cid: ""', { timeout: 30_000 });

        const signingLog = await testHost.getSigningLog();
        expect(signingLog).toHaveLength(0);
    });
});
