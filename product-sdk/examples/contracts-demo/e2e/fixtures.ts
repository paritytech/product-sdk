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
import { LIVE_CHAINS, liveChain } from "@parity/truapi-host/testing/dev-accounts";

export const SS58_PREFIX = 0; // Paseo Asset Hub — addresses start with "1"
const PRODUCT_URL = "http://localhost:5201";

export const test = base.extend<{ testHost: TestHost }>(
    createTestHostFixture({
        productUrl: PRODUCT_URL,
        productId: "contracts-demo.dot",
        accounts: ["alice", "bob", "charlie", "dave"],
        // Reads real contract state, so proxy to the real Asset Hub.
        ...liveChain(LIVE_CHAINS.paseoAssetHub),
    }),
);
export { expect } from "@playwright/test";
