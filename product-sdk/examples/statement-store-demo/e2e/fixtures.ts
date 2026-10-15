// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// TrUAPI-native fixture. Only the source of the fixture changed; the specs and
// their assertions are untouched.
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    type TestHost,
} from "@parity/truapi-host/testing/playwright";

export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5220";

export const test = base.extend<{ testHost: TestHost }>(
    createTestHostFixture({
        productUrl: PRODUCT_URL,
        productId: "statement-store-demo.dot",
        accounts: ["alice", "bob", "charlie", "dave"],
        // The statement store flows over the people chain. Declared through
        // `networks` with a `-people` id so the host knows the chain's role:
        // that is what lets it serve the store in-page rather than refusing
        // what a real one would.
        networks: [
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
