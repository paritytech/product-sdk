// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type ChainConfig,
    type HexString,
    type NetworkConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";

const PRODUCT_URL = "http://localhost:5280";

/**
 * Paseo Asset Hub config with a configurable RPC endpoint.
 *
 * The genesis comes from the descriptor because the test SDK constant lags chain
 * resets, and a stale one makes the host refuse the chain.
 *
 * Override via `PASEO_AH_RPC` if the default RPC has outages. The override must
 * serve the same chain as the descriptor genesis. A mirror on any other genesis
 * fails the chain handshake, seen as `Tracking stopped` or `BadProof`.
 *
 * The chain matters more here than in the other demos: `Scarcity` and
 * `NftClaims` are not on every network the SDK supports, and `devnet-asset-hub`
 * carries neither.
 */
const PASEO_AH: ChainConfig = {
    ...PASEO_ASSET_HUB,
    genesisHash: paseo_asset_hub.genesis as HexString,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io",
};

/**
 * The People chain, which the credits read needs beside Asset Hub. The genesis
 * comes from the descriptor for the same reason as above.
 */
const PASEO_PEOPLE: NetworkConfig = {
    id: "paseo-people",
    name: "Paseo People",
    genesisHash: paseo_individuality.genesis as HexString,
    rpcUrl: process.env.PASEO_PEOPLE_RPC ?? "wss://paseo-people-next-system-rpc.polkadot.io",
    tokenSymbol: "PAS",
    tokenDecimals: 10,
    chain: "People",
};

/**
 * The catalogue reads need no account and the credits read takes its claimant
 * as an argument, so the account is incidental. The fixture still needs one to
 * boot the host, and Bob is what the sibling demos use.
 */
const bobFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    networks: [PASEO_AH, PASEO_PEOPLE],
    productAccounts: { "nfts-demo.dot": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(bobFixture);
export { expect } from "@playwright/test";
