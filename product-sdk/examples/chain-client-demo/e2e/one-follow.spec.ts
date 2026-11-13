// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures";
import { waitForAppReady } from "./helpers";

/**
 * One follow per chain per product, against the real host on live Asset Hub.
 *
 * The test host records every JSON-RPC line the core sends upstream, so the
 * `chainHead_v1_follow` requests in it are the follows the host opened for this
 * product. The product's own check is the error the SDK logs when a second
 * connection follows a chain another connection already follows.
 *
 * Verifies that:
 *   - two more createChainClient configs over Asset Hub, one naming the chain
 *     differently and one the boot config again, add no follow and share the
 *     raw client.
 *   - no "follows from this product" error is logged for them.
 *   - a client built straight from getHostProvider adds one follow and is reported.
 *   - destroying the extra configs leaves the chain open for the boot client.
 */
test.describe("@parity/product-sdk-chain-client via Host API — one follow per chain", () => {
    test("configs sharing Asset Hub share one follow at the host", async ({ testHost }) => {
        const errors: string[] = [];
        testHost.page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
        });
        const followErrors = () => errors.filter((line) => line.includes("follows from this product"));
        const followsSent = async () =>
            (await testHost.getSentRpc()).filter((line) => line.includes('"chainHead_v1_follow"'))
                .length;

        const frame = await waitForAppReady(testHost);
        const atBoot = await followsSent();
        console.log(`follows sent upstream at boot: ${atBoot}`);
        expect(atBoot).toBeGreaterThanOrEqual(1);

        // Two more configs over the same chain: one names it differently, the
        // other is the boot config again.
        const shared = await frame.locator("body").evaluate(async () => {
            const cc = window.__CHAIN_CLIENT__;
            const [other, again] = await Promise.all([
                cc.createChainClient({ chains: { ah: cc.paseo_asset_hub } }),
                cc.createChainClient({ chains: { assetHub: cc.paseo_asset_hub } }),
            ]);
            const [viaOther, viaAgain] = await Promise.all([
                other.ah.query.System.Number.getValue(),
                again.assetHub.query.System.Number.getValue(),
            ]);
            const boot = cc.byodClient;
            (window as unknown as { __EXTRA__: unknown }).__EXTRA__ = { other, again };
            return {
                viaOther,
                viaAgain,
                sameRaw:
                    boot !== null &&
                    other.raw.ah === boot.raw.assetHub &&
                    again.raw.assetHub === boot.raw.assetHub,
                sameApi: boot !== null && again.assetHub === boot.assetHub,
                connected: cc.isConnected(cc.paseo_asset_hub),
            };
        });
        expect(shared.viaOther).toBeGreaterThan(0);
        expect(shared.viaAgain).toBeGreaterThan(0);
        expect(shared.sameRaw).toBe(true);
        expect(shared.sameApi).toBe(true);
        expect(shared.connected).toBe(true);
        expect(await followsSent()).toBe(atBoot);
        expect(followErrors()).toEqual([]);

        // A client built outside createChainClient is a second follow, and the
        // SDK says so.
        const rawBlock = await frame.locator("body").evaluate(async () => {
            const cc = window.__CHAIN_CLIENT__;
            const provider = await cc.getHostProvider(cc.paseo_asset_hub.genesis as `0x${string}`);
            if (!provider) throw new Error("host provider unavailable");
            const client = cc.createClient(provider);
            (window as unknown as { __RAW__: unknown }).__RAW__ = client;
            return client.getTypedApi(cc.paseo_asset_hub).query.System.Number.getValue();
        });
        expect(rawBlock).toBeGreaterThan(0);
        await expect.poll(followsSent, { timeout: 30_000 }).toBe(atBoot + 1);
        await expect.poll(followErrors).toHaveLength(1);
        expect(followErrors()[0]).toContain("now has 2 follows from this product");

        // Giving back the extra configs leaves the chain open for the boot client.
        const afterRelease = await frame.locator("body").evaluate(() => {
            const cc = window.__CHAIN_CLIENT__;
            const extra = (
                window as unknown as {
                    __EXTRA__: { other: { destroy(): void }; again: { destroy(): void } };
                }
            ).__EXTRA__;
            extra.other.destroy();
            extra.again.destroy();
            extra.again.destroy();
            (window as unknown as { __RAW__: { destroy(): void } }).__RAW__.destroy();
            return {
                connected: cc.isConnected(cc.paseo_asset_hub),
                sameClient: cc.getClient(cc.paseo_asset_hub) === cc.byodClient?.raw.assetHub,
            };
        });
        expect(afterRelease.connected).toBe(true);
        expect(afterRelease.sameClient).toBe(true);
        const stillWorks = await frame.locator("body").evaluate(() =>
            window.__CHAIN_CLIENT__.byodClient?.assetHub.query.System.Number.getValue(),
        );
        expect(stillWorks).toBeGreaterThan(0);
        expect(await followsSent()).toBe(atBoot + 1);
        expect(followErrors()).toHaveLength(1);
    });
});
