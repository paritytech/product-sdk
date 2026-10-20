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

/**
 * RFC-0010 resource allocation for auth consumers: the default resource set
 * a CLI product needs, and a summary of what the wallet granted. The call
 * itself is terminal's `requestResourceAllocation`.
 */
import {
    type AllocatableResource,
    type AllocationOutcome,
    type TerminalAdapter,
    requestResourceAllocation as requestFromWallet,
} from "@parity/product-sdk-terminal";

export type { AllocatableResource, AllocationOutcome } from "@parity/product-sdk-terminal";

export type ResourceTag = AllocatableResource["tag"];

/**
 * What a CLI product account needs before it can publish and transact:
 * Bulletin and statement-store writes, and PGAS sponsoring for the default
 * (index 0) account.
 */
export const DEFAULT_RESOURCES: AllocatableResource[] = [
    { tag: "BulletinAllowance" },
    { tag: "StatementStoreAllowance" },
    { tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } },
];

/**
 * Ask the paired wallet to allocate `resources` for `productId`. The wallet
 * prompts the user and answers one outcome per resource, in order; refusals
 * are outcomes, transport failures throw.
 */
export function requestResourceAllocation(
    adapter: TerminalAdapter,
    productId: string,
    resources: AllocatableResource[] = DEFAULT_RESOURCES,
): Promise<AllocationOutcome[]> {
    return requestFromWallet(adapter, resources, { productId });
}

export interface AllocationSummary {
    granted: AllocatableResource[];
    rejected: AllocatableResource[];
    unavailable: AllocatableResource[];
}

/** Group resources by the outcome the wallet gave each; `outcomes[i]` answers `resources[i]`. */
export function summarizeOutcomes(
    outcomes: AllocationOutcome[],
    resources: AllocatableResource[],
): AllocationSummary {
    const summary: AllocationSummary = { granted: [], rejected: [], unavailable: [] };
    outcomes.forEach((outcome, index) => {
        const resource = resources[index];
        if (!resource) return;
        if (outcome === "Allocated") summary.granted.push(resource);
        else if (outcome === "Rejected") summary.rejected.push(resource);
        else summary.unavailable.push(resource);
    });
    return summary;
}
