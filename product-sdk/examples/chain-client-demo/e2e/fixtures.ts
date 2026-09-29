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
import { LIVE_CHAINS } from "@parity/truapi-host/testing/dev-accounts";

export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5260";

export const test = base.extend<{ testHost: TestHost }>(
    createTestHostFixture({
        productUrl: PRODUCT_URL,
        productId: "chain-client-demo.dot",
        accounts: ["alice", "bob", "charlie", "dave"],
        // This suite reads real chain state, so the host proxies to the real
        // Asset Hub. The proxy carries no genesis hash, so it takes whatever
        // chain the core asks for and a chain reset cannot break routing.
        mock: { chainProxies: [LIVE_CHAINS.paseoAssetHub] },
    }),
);
export { expect } from "@playwright/test";
