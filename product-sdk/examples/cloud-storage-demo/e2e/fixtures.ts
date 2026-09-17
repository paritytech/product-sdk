// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type HexString,
    type NetworkConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5230";

/**
 * Paseo Asset Hub config for account resolution. The preimage manager
 * host API is independent of the chain connection — it's a separate
 * protocol. The bulletin chain itself connects via direct WS fallback.
 *
 * The genesis comes from the descriptor because the test SDK's constant lags
 * chain resets, and a stale one makes the host reject the chain.
 */
const PASEO_AH: NetworkConfig = {
    ...PASEO_ASSET_HUB,
    genesisHash: paseo_asset_hub.genesis as HexString,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io",
};

const bobFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    networks: [PASEO_AH],
    productAccounts: { "bulletin-demo.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(bobFixture);
export { expect } from "@playwright/test";
