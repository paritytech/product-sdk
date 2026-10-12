// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// TrUAPI-native fixture. Only the source of the fixture changed; the specs and
// their assertions are untouched.
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type TestHost,
} from "@parity/truapi-host/testing/playwright";

export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5280";

export const test = base.extend<{ testHost: TestHost }>(
    createTestHostFixture({
        productUrl: PRODUCT_URL,
        productId: "nfts-demo.dot",
        accounts: ["alice", "bob", "charlie", "dave"],
        // Reads Scarcity/NftClaims on Asset Hub and the credits read on People,
        // so the host proxies both. Declared through `networks` so each carries
        // its own genesis and routing stays correct across the two chains;
        // `Scarcity` and `NftClaims` live on Asset Hub and nowhere the SDK also
        // supports, so the hub genesis has to be the real one.
        networks: [
            PASEO_ASSET_HUB,
            {
                id: "paseo-people",
                name: "Paseo People",
                genesisHash:
                    "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48",
                rpcUrl: "wss://paseo-people-next-system-rpc.polkadot.io",
            },
        ],
    }),
);
export { expect } from "@playwright/test";
