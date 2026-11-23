// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * RFC-0010 resource allocation: ask the paired wallet for the statement-store,
 * Bulletin and smart-contract allowances a product account needs. The wallet
 * prompts the user; the core keeps the allowance keys and uses them itself.
 */
import type { AllocatableResource, AllocationOutcome } from "@parity/truapi";

import type { TerminalAdapter } from "./adapter.js";
import { describeCallError } from "./call-error.js";

export type { AllocatableResource, AllocationOutcome };

/**
 * One outcome per requested resource, in order. A refused or unavailable
 * resource is an outcome, not an error; transport failures throw.
 */
export async function requestResourceAllocation(
    adapter: TerminalAdapter,
    resources: AllocatableResource[],
    options: { productId?: string } = {},
): Promise<AllocationOutcome[]> {
    const client = await adapter.client(options.productId);
    const allocated = await client.resourceAllocation.request({ resources });
    if (allocated.isErr()) {
        throw new Error(`requestResourceAllocation failed: ${describeCallError(allocated.error)}`);
    }
    return allocated.value.outcomes;
}
