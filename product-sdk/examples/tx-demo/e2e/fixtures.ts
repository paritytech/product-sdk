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

// Paseo Asset Hub uses SS58 prefix 0 → addresses start with "1".
export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5200";

/**
 * Paseo Asset Hub config with a configurable RPC endpoint.
 *
 * The genesis comes from the descriptor because the test SDK's constant lags
 * chain resets, and a stale one makes the host reject the chain.
 *
 * Override via `PASEO_AH_RPC` if the default RPC has outages. The override must
 * serve the same chain as the descriptor's genesis; a mirror on any other
 * genesis fails the chain handshake (seen as `Tracking stopped` / `BadProof`).
 */
const PASEO_AH: NetworkConfig = {
    ...PASEO_ASSET_HUB,
    genesisHash: paseo_asset_hub.genesis as HexString,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io",
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
    networks: [PASEO_AH],
    productAccounts: { "tx-demo.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(bobFixture);
export { expect } from "@playwright/test";
