import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type ChainConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5230";

/**
 * Paseo Asset Hub config for account resolution. The preimage manager
 * host API is independent of the chain connection — it's a separate
 * protocol. The bulletin chain itself connects via direct WS fallback.
 */
const PASEO_AH: ChainConfig = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://sys.turboflakes.io/asset-hub-paseo",
};

const bobFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    chain: PASEO_AH,
    productAccounts: { "bulletin-demo.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(bobFixture);
export { expect } from "@playwright/test";
