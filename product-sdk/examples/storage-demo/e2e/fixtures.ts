// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// TrUAPI-native fixture. The only change from the host-api-test-sdk version is
// where the fixture comes from: the assertions in the specs are untouched.
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    type TestHost,
} from "@parity/truapi-host/testing/playwright";

// Paseo Asset Hub uses SS58 prefix 0 → addresses start with "1".
export const SS58_PREFIX = 0;
const PRODUCT_URL = "http://localhost:5250";

export const test = base.extend<{ testHost: TestHost }>(
    createTestHostFixture({
        productUrl: PRODUCT_URL,
        productId: "storage-demo.dot",
        accounts: ["alice", "bob", "charlie", "dave"],
    }),
);
export { expect } from "@playwright/test";
