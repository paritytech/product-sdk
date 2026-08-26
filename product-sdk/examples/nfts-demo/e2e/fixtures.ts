// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type ChainConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

const PRODUCT_URL = "http://localhost:5280";

/**
 * Paseo Asset Hub config with a configurable RPC endpoint.
 *
 * Override via `PASEO_AH_RPC` if the default RPC has outages. The override must
 * serve the same chain as `PASEO_ASSET_HUB.genesisHash`; a mirror on any other
 * genesis fails the chain handshake (seen as `Tracking stopped` / `BadProof`).
 *
 * The chain matters more here than in the other demos: `Scarcity` and
 * `NftClaims` are not on every network the SDK supports, and `devnet-asset-hub`
 * carries neither.
 */
const PASEO_AH: ChainConfig = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io",
};

/**
 * Both reads are catalogue reads, so the account is incidental — the fixture
 * still needs one to boot the host, and Bob is what the sibling demos use.
 */
const bobFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    chain: PASEO_AH,
    productAccounts: { "nfts-demo.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(bobFixture);
export { expect } from "@playwright/test";
