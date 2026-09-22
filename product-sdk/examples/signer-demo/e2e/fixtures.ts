// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type NetworkConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

// Paseo Asset Hub uses SS58 prefix 0 → addresses start with "1".
export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5210";

/**
 * Paseo Asset Hub config with a configurable RPC endpoint.
 *
 * Override via `PASEO_AH_RPC` if the default RPC has outages. The override must
 * serve the same chain as `PASEO_ASSET_HUB.genesisHash`; a mirror on any other
 * genesis fails the chain handshake (seen as `Tracking stopped` / `BadProof`).
 */
const PASEO_AH: NetworkConfig = {
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
    productId: "signer-demo.dot",
    accounts: ["bob", "charlie"],
    networks: [PASEO_AH],
    productAccounts: { "signer-demo.dot": "bob" },
    // Withhold AutoSigning as a boot option (not via
    // setResourceAllocationBehavior(), which runs too late — signer-demo
    // requests AutoSigning inside onConnect, before a post-boot setter could
    // land). With AutoSigning granted, the core signs inside its own worker
    // with no host round-trip, so nothing reaches getSigningLog(). Withholding
    // it routes signing back through the SSO path, where it's observable
    // again. The record form grants everything it doesn't mention, so the
    // other allocatable resources (StatementStoreAllowance, BulletinAllowance,
    // SmartContractAllowance) are unaffected. Note this record governs
    // resource allocation only — permission tags such as ChainSubmit sit on a
    // different axis entirely (setPermissionBehavior / grantPermission) and
    // are untouched by it.
    behaviors: { resourceAllocation: { AutoSigning: false } },
});

export const test = base.extend<{ testHost: TestHost }>(fixture);
export { expect } from "@playwright/test";
