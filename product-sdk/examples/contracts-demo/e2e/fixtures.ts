// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
 * Override via `PASEO_AH_RPC` if the default RPC has outages — but the override
 * must serve **paseo v2** (genesis `0x173cea9d…`). Any mirror still pointing at
 * v1 paseo will hash-mismatch the spread `PASEO_ASSET_HUB.genesisHash` and
 * break the chain-handshake.
 */
const PASEO_AH: ChainConfig = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io",
};

const bobFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    chain: PASEO_AH,
    productAccounts: { "contracts-demo.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(bobFixture);
export { expect } from "@playwright/test";
