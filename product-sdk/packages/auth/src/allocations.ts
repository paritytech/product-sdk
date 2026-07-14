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
 * RFC-0010 `host_request_resource_allocation` helpers for auth consumers.
 *
 * The wire call, and the resource / outcome types, live in
 * `@parity/product-sdk-terminal` (derived from `UserSession` so they can't
 * drift from the host codec). This module delegates the wire call to terminal's
 * `sendResourceAllocation` — the cache-free primitive — and layers on the
 * auth-consumer conveniences (`DEFAULT_RESOURCES`, `summarizeOutcomes`) plus a
 * `productId`-based signature so headless callers don't need a `TerminalAdapter`.
 *
 * The mobile app handles `hostRequestResourceAllocation` in
 * `AllowanceHostCalls.kt` and routes the user through an approval UI.
 */

import type { UserSession } from "@parity/product-sdk-terminal";
import {
    type AllocatableResource,
    type ApAllocationOutcome,
    type OnExistingAllowancePolicy,
    sendResourceAllocation,
} from "@parity/product-sdk-terminal";

export type { AllocatableResource, OnExistingAllowancePolicy } from "@parity/product-sdk-terminal";

/**
 * Outcome of one allocation. Re-exported from terminal's wire-derived type
 * under the name auth consumers already use. We don't read the inner
 * `Allocated` payload (allowance slot keys, derivation secrets) — the host
 * stores them and uses them transparently on subsequent calls. We just need
 * the tag to know whether the allocation succeeded.
 */
export type AllocationOutcome = ApAllocationOutcome;

/** Tag-only view, handy for downstream code that doesn't care about payloads. */
export type ResourceTag = AllocatableResource["tag"];

/**
 * Default mobile-granted resource set for a CLI product account: write access
 * to the statement store + Bulletin, plus PGAS sponsoring for the default
 * (index 0) product account.
 */
export const DEFAULT_RESOURCES: AllocatableResource[] = [
    { tag: "BulletInAllowance", value: undefined },
    { tag: "StatementStoreAllowance", value: undefined },
    // derivation index 0 = the default product account.
    { tag: "SmartContractAllowance", value: 0 },
];

/**
 * Send a `host_request_resource_allocation` request over the user's active
 * session. The host (mobile wallet) prompts the user to approve and returns
 * one outcome per requested resource in order.
 *
 * Throws on transport-level failures (Statement Store unreachable, encryption
 * error, etc.). Per-resource refusals are reported as `Rejected`/`NotAvailable`
 * outcomes — callers inspect the array to decide whether to proceed.
 */
export async function requestResourceAllocation(
    session: UserSession,
    productId: string,
    resources: AllocatableResource[] = DEFAULT_RESOURCES,
    onExisting: OnExistingAllowancePolicy = "Ignore",
): Promise<AllocationOutcome[]> {
    return sendResourceAllocation(session, productId, resources, onExisting);
}

export interface AllocationSummary {
    granted: AllocatableResource[];
    rejected: AllocatableResource[];
    unavailable: AllocatableResource[];
}

/**
 * Bucket allocation outcomes by tag. Order-sensitive: `outcomes[i]` maps to
 * `resources[i]`. Outcomes without a matching resource are silently dropped.
 */
export function summarizeOutcomes(
    outcomes: AllocationOutcome[],
    resources: AllocatableResource[],
): AllocationSummary {
    const granted: AllocatableResource[] = [];
    const rejected: AllocatableResource[] = [];
    const unavailable: AllocatableResource[] = [];
    outcomes.forEach((outcome, i) => {
        const resource = resources[i];
        if (!resource) return;
        if (outcome.tag === "Allocated") granted.push(resource);
        else if (outcome.tag === "Rejected") rejected.push(resource);
        else unavailable.push(resource);
    });
    return { granted, rejected, unavailable };
}
