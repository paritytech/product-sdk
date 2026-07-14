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
import {
    DEFAULT_RESOURCES,
    summarizeOutcomes,
    type AllocatableResource,
    type AllocationOutcome,
} from "./allocations.js";

describe("summarizeOutcomes", () => {
    const resources: AllocatableResource[] = [
        { tag: "BulletInAllowance", value: undefined },
        { tag: "StatementStoreAllowance", value: undefined },
        { tag: "SmartContractAllowance", value: 0 },
    ];

    test("buckets outcomes by tag, mapping outcomes[i] → resources[i]", () => {
        const outcomes: AllocationOutcome[] = [
            { tag: "Allocated", value: {} },
            { tag: "Rejected", value: undefined },
            { tag: "NotAvailable", value: undefined },
        ];
        const summary = summarizeOutcomes(outcomes, resources);
        expect(summary.granted.map((r) => r.tag)).toEqual(["BulletInAllowance"]);
        expect(summary.rejected.map((r) => r.tag)).toEqual(["StatementStoreAllowance"]);
        expect(summary.unavailable.map((r) => r.tag)).toEqual(["SmartContractAllowance"]);
    });

    test("all granted", () => {
        const outcomes: AllocationOutcome[] = resources.map(() => ({
            tag: "Allocated",
            value: {},
        }));
        const summary = summarizeOutcomes(outcomes, resources);
        expect(summary.granted).toHaveLength(3);
        expect(summary.rejected).toHaveLength(0);
        expect(summary.unavailable).toHaveLength(0);
    });

    test("drops outcomes with no matching resource (index past resources)", () => {
        const outcomes: AllocationOutcome[] = [
            { tag: "Allocated", value: {} },
            { tag: "Allocated", value: {} }, // no resources[1]
        ];
        const summary = summarizeOutcomes(outcomes, [resources[0]]);
        expect(summary.granted).toHaveLength(1);
    });

    test("DEFAULT_RESOURCES carries the three expected allowances", () => {
        expect(DEFAULT_RESOURCES.map((r) => r.tag)).toEqual([
            "BulletInAllowance",
            "StatementStoreAllowance",
            "SmartContractAllowance",
        ]);
    });
});
