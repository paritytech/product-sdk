import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type ChainConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

export const SS58_PREFIX = 0; // Paseo Asset Hub — addresses start with "1"
const PRODUCT_URL = "http://localhost:5201";

/**
 * Paseo Asset Hub config with a configurable RPC endpoint.
 * Override via `PASEO_AH_RPC` env var if the default is flaky.
 */
const PASEO_AH: ChainConfig = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://sys.turboflakes.io/asset-hub-paseo",
};

const bobFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    chain: PASEO_AH,
    productAccounts: { "contracts-demo.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(bobFixture);
export { expect } from "@playwright/test";
