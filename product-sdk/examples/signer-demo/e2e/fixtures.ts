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
const PRODUCT_URL = "http://localhost:5210";

export const test = base.extend<{ testHost: TestHost }>(
    createTestHostFixture({
        productUrl: PRODUCT_URL,
        productId: "signer-demo.dot",
        accounts: ["alice", "bob", "charlie", "dave"],
    }),
);
export { expect } from "@playwright/test";
