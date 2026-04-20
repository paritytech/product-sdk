import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type ChainConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

// Paseo Asset Hub uses SS58 prefix 0 → addresses start with "1".
export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5210";

/**
 * The test SDK hardcodes `wss://sys.ibp.network/asset-hub-paseo` in the
 * built-in `PASEO_ASSET_HUB` config, which has been flaky (502s). Override
 * via `PASEO_AH_RPC` for CI/local environments that hit outages.
 */
const PASEO_AH: ChainConfig = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://sys.turboflakes.io/asset-hub-paseo",
};

/**
 * Default fixture: Bob + Charlie both available as non-product accounts.
 * Tests start with Bob selected (first in the list), and can switch to
 * Charlie via `testHost.switchAccount("charlie")`.
 */
const fixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob", "charlie"],
    chain: PASEO_AH,
    productAccounts: { "signer-demo.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(fixture);
export { expect } from "@playwright/test";
