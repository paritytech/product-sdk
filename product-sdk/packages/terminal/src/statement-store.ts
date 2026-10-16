// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Statements and Bulletin preimages, proved and submitted by the core with the
 * allowances the wallet granted. The keys never leave the core.
 */
import type { SignedStatement, Statement, StatementProof } from "@parity/truapi";
import { toHex } from "@polkadot-api/utils";

import type { TerminalAdapter } from "./adapter.js";
import { describeCallError } from "./call-error.js";

export type { SignedStatement, Statement, StatementProof };

/** Proves statements for one product with its statement-store allowance. */
export interface StatementStoreProver {
    createProof(statement: Statement): Promise<StatementProof>;
}

/** A prover for `productId`. Request `StatementStoreAllowance` for it first. */
export async function getStatementStoreProver(
    adapter: TerminalAdapter,
    productId?: string,
): Promise<StatementStoreProver> {
    const client = await adapter.client(productId);
    return {
        async createProof(statement) {
            const proved = await client.statementStore.createProofAuthorized(statement);
            if (proved.isErr())
                throw new Error(`createProof failed: ${describeCallError(proved.error)}`);
            return proved.value.proof;
        },
    };
}

/** Submit a proved statement to the People chain's statement store. */
export async function submitStatement(
    adapter: TerminalAdapter,
    statement: SignedStatement,
    productId?: string,
): Promise<void> {
    const client = await adapter.client(productId);
    const submitted = await client.statementStore.submit(statement);
    if (submitted.isErr())
        throw new Error(`submitStatement failed: ${describeCallError(submitted.error)}`);
}

/**
 * Store `data` on Bulletin with the product's Bulletin allowance and return
 * its preimage key. Request `BulletinAllowance` for the product first.
 */
export async function submitPreimage(
    adapter: TerminalAdapter,
    data: Uint8Array,
    productId?: string,
): Promise<`0x${string}`> {
    const client = await adapter.client(productId);
    const stored = await client.preimage.submit(toHex(data) as `0x${string}`);
    if (stored.isErr())
        throw new Error(`submitPreimage failed: ${describeCallError(stored.error)}`);
    return stored.value;
}
