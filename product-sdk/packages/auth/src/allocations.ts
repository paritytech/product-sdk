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
 * Thin wrapper over the RFC-0010 `host_request_resource_allocation` call.
 * Lifted from playground-cli `src/utils/allowances/host.ts` (issue #411).
 *
 * `@parity/product-sdk-terminal` does not yet re-export this API at its
 * package root, but the underlying `UserSession` (from `@novasamatech/host-papp`)
 * exposes `requestResourceAllocation()`. We call it directly here and gate the
 * shape locally so consumers stay decoupled from the deep import path. Replace
 * this whole module with a `product-sdk-terminal` re-export once the SDK
 * surfaces the same call.
 *
 * Wire format (SCALE-derived, mirrors host-papp's
 * `dist/sso/sessionManager/scale/resourceAllocation.d.ts`):
 *   request  → { callingProductId, resources: AllocatableResource[], onExisting }
 *   response → AllocationOutcome[] (one per resource, in order)
 *
 * The mobile app handles `hostRequestResourceAllocation` in
 * `AllowanceHostCalls.kt` and routes the user through an approval UI.
 */

import type { UserSession } from "@parity/product-sdk-terminal";

/**
 * Structural mirror of host-papp's `ApAllocatableResource` codec type. We
 * declare it locally because host-papp's package root doesn't re-export the
 * codec types yet — when it does (and product-sdk-terminal threads them
 * through) this can be replaced with a direct import.
 *
 *   StatementStoreAllowance — write to the SSS (host_chat, allowance ring).
 *   BulletInAllowance       — write to Bulletin (TransactionStorage.store).
 *   SmartContractAllowance  — PGAS sponsoring for Revive contract calls.
 *                             The `value` is the derivation index of the
 *                             product account (0 for the default account).
 *   AutoSigning             — surrender the product-account signing key to
 *                             the host so it can sign on the user's behalf
 *                             without per-call prompts. Not used today.
 */
export type AllocatableResource =
    | { tag: "StatementStoreAllowance"; value: undefined }
    | { tag: "BulletInAllowance"; value: undefined }
    | { tag: "SmartContractAllowance"; value: number }
    | { tag: "AutoSigning"; value: undefined };

/**
 * Outcome of one allocation. We don't read the inner `Allocated` payload
 * (allowance slot keys, derivation secrets) — the host stores them and uses
 * them transparently on subsequent calls. We just need the tag to know
 * whether the allocation succeeded.
 */
export type AllocationOutcome =
    | { tag: "Allocated"; value: unknown }
    | { tag: "Rejected"; value: undefined }
    | { tag: "NotAvailable"; value: undefined };

/** Tag-only view, handy for downstream code that doesn't care about payloads. */
export type ResourceTag = AllocatableResource["tag"];

export type OnExistingAllowancePolicy = "Ignore" | "Increase";

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
    const result = await session.requestResourceAllocation({
        callingProductId: productId,
        resources,
        onExisting,
    });
    if (result.isErr()) {
        throw new Error(`Resource allocation request failed: ${result.error.message}`);
    }
    return result.value as AllocationOutcome[];
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
