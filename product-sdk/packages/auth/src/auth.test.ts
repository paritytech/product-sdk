// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { describe, expect, test } from "vitest";
import { createAuthClient } from "./auth.js";
import type { AuthConfig } from "./types.js";

const config: AuthConfig = {
    dappId: "test-app",
    productId: "test.dot",
    derivationIndex: 0,
    peopleEndpoints: ["wss://example.com/people"],
};

describe("createAuthClient", () => {
    test("returns the bound auth surface (all functions)", () => {
        const client = createAuthClient(config);
        for (const fn of [
            "connect",
            "waitForLogin",
            "getSessionSigner",
            "findSession",
            "waitForLogout",
            "requestAllocation",
            "clearLocalAppStorage",
        ] as const) {
            expect(typeof client[fn]).toBe("function");
        }
    });

    test("clearLocalAppStorage returns (no throw) when the dir does not exist", async () => {
        const client = createAuthClient(config);
        await expect(
            client.clearLocalAppStorage("/nonexistent/dir/should-not-exist-xyz"),
        ).resolves.toBeUndefined();
    });
});
