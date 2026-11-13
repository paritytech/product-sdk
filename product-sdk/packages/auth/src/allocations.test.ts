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
import { DEFAULT_RESOURCES, summarizeOutcomes, type AllocatableResource } from "./allocations.js";

describe("summarizeOutcomes", () => {
    const resources: AllocatableResource[] = [
        { tag: "BulletinAllowance" },
        { tag: "StatementStoreAllowance" },
        { tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } },
    ];

    // The wallet answers positionally, so each outcome belongs to the resource at its index.
    test("groups each resource under the outcome at its index", () => {
        expect(summarizeOutcomes(["Allocated", "Rejected", "NotAvailable"], resources)).toEqual({
            granted: [resources[0]],
            rejected: [resources[1]],
            unavailable: [resources[2]],
        });
    });

    test("ignores outcomes past the end of the resources", () => {
        expect(summarizeOutcomes(["Allocated", "Allocated"], [resources[0]!])).toEqual({
            granted: [resources[0]],
            rejected: [],
            unavailable: [],
        });
    });

    test("the default set asks for Bulletin, statement-store and PGAS for account 0", () => {
        expect(DEFAULT_RESOURCES).toEqual(resources);
    });
});
