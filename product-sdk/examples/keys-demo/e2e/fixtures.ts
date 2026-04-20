import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type ChainConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

// Paseo Asset Hub uses SS58 prefix 0 -> addresses start with "1".
export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5270";

/**
 * Paseo Asset Hub config with a configurable RPC endpoint.
 *
 * The test SDK's built-in `PASEO_ASSET_HUB` points at `wss://sys.ibp.network/asset-hub-paseo`,
 * which has been flaky (502s) during development. Override via `PASEO_AH_RPC` in CI/local
 * if you hit outages — the genesis hash is fixed, so any healthy Paseo AH RPC works.
 */
const PASEO_AH: ChainConfig = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://sys.turboflakes.io/asset-hub-paseo",
};

/**
 * Default fixture: Bob on Paseo Asset Hub.
 *
 * `productAccounts` maps this app's DotNS-derived account (used by `SignerManager`
 * when it asks the host for a non-product account) to the funded dev keypair.
 */
const bobFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    chain: PASEO_AH,
    productAccounts: { "keys-demo.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(bobFixture);
export { expect } from "@playwright/test";
