// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
 * Override via `PASEO_AH_RPC` in CI/local if the default RPC has outages — but
 * the override must serve **paseo v2** (genesis `0x173cea9d…`). Any mirror still
 * pointing at v1 paseo will hash-mismatch the spread `PASEO_ASSET_HUB.genesisHash`
 * and break the chain-handshake (manifesting as `Tracking stopped` / `BadProof`).
 */
const PASEO_AH: ChainConfig = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io",
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
