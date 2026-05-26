// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { PolkadotSigner } from "polkadot-api";

/** Transaction lifecycle status for UI callbacks. */
export type TxStatus = "signing" | "broadcasting" | "in-block" | "finalized" | "error";

/** When to resolve the submission promise. */
export type WaitFor = "best-block" | "finalized";

/** Successful transaction result. */
export interface TxResult {
    /** Transaction hash. */
    txHash: string;
    /** Whether the on-chain dispatch succeeded. */
    ok: boolean;
    /** Block where the transaction was included. */
    block: { hash: string; number: number; index: number };
    /** Raw events emitted by the transaction. */
    events: unknown[];
    /** Dispatch error details when ok is false. */
    dispatchError?: unknown;
}

/** Options for {@link submitAndWatch}. */
export interface SubmitOptions {
    /** When to resolve the promise. Default: `"best-block"`. */
    waitFor?: WaitFor;
    /** Timeout in milliseconds. Default: `300_000` (5 minutes). */
    timeoutMs?: number;
    /** Mortality period in blocks. Default: `256` (~43 minutes on Polkadot). */
    mortalityPeriod?: number;
    /** Called on each lifecycle transition for UI progress indicators. */
    onStatus?: (status: TxStatus) => void;
}

/** Options for {@link withRetry}. */
export interface RetryOptions {
    /** Total attempts including the first. Default: `3`. */
    maxAttempts?: number;
    /** Base delay in ms for exponential backoff. Default: `1_000`. */
    baseDelayMs?: number;
    /** Maximum delay in ms. Default: `15_000`. */
    maxDelayMs?: number;
}

/**
 * Substrate weight representing computational and storage resources.
 *
 * Matches the shape returned by `ReviveApi.call` and `ReviveApi.eth_transact`
 * dry-run results in the `weight_required` field.
 */
export interface Weight {
    /** Reference time component in picoseconds. */
    ref_time: bigint;
    /** Proof size component in bytes. */
    proof_size: bigint;
}

/** Standard Substrate dev account names. */
export type DevAccountName = "Alice" | "Bob" | "Charlie" | "Dave" | "Eve" | "Ferdie";

/**
 * Structural type for any transaction object that supports Observable-based
 * sign-submit-and-watch. Works with raw PAPI transactions and Ink SDK
 * resolved transactions.
 */
export interface SubmittableTransaction {
    signSubmitAndWatch: (
        signer: PolkadotSigner,
        options?: { mortality?: { mortal: boolean; period: number } },
    ) => {
        subscribe: (handlers: {
            next: (event: TxEvent) => void;
            error: (error: Error) => void;
        }) => { unsubscribe: () => void };
    };
    /** Present on Ink SDK AsyncTransaction wrappers. */
    waited?: Promise<SubmittableTransaction>;
    /** The decoded call data. Present on PAPI transactions. */
    decodedCall?: unknown;
}

/** Batch execution mode corresponding to Substrate's Utility pallet. */
export type BatchMode = "batch_all" | "batch" | "force_batch";

/**
 * A transaction or decoded call that can be included in a batch.
 *
 * Accepts:
 * - A {@link SubmittableTransaction} (has `.decodedCall`)
 * - An Ink SDK AsyncTransaction (has `.waited` that resolves to one with `.decodedCall`)
 * - A raw decoded call object (passed through as `Record<string, unknown>`)
 *
 * The `Record<string, unknown>` variant is intentionally broad because PAPI decoded
 * calls are chain-specific enum types that cannot be imported without chain descriptors.
 * Runtime validation in `resolveDecodedCall` rejects null, undefined, and primitives.
 */
export type BatchableCall =
    | SubmittableTransaction
    | { decodedCall: unknown }
    | Record<string, unknown>;

/** Options for {@link batchSubmitAndWatch}. Extends {@link SubmitOptions} with batch mode. */
export interface BatchSubmitOptions extends SubmitOptions {
    /**
     * Batch execution mode. Default: `"batch_all"` (atomic, all-or-nothing).
     *
     * - `"batch_all"` — Atomic. Reverts all calls if any single call fails.
     * - `"batch"` — Best-effort. Stops at first failure but earlier successful calls are not reverted.
     * - `"force_batch"` — Like `batch` but continues executing remaining calls after failures (never aborts early).
     */
    mode?: BatchMode;
}

/**
 * Minimal structural type for a PAPI typed API with the Utility pallet.
 *
 * Structural so it works with any chain that has the Utility pallet, without
 * importing chain-specific descriptors.
 */
export interface BatchApi {
    tx: {
        Utility: {
            batch(args: { calls: unknown[] }): SubmittableTransaction;
            batch_all(args: { calls: unknown[] }): SubmittableTransaction;
            force_batch(args: { calls: unknown[] }): SubmittableTransaction;
        };
    };
}

/** PAPI transaction event (discriminated union). */
export type TxEvent =
    | { type: "signed"; txHash: string }
    | { type: "broadcasted"; txHash: string }
    | {
          type: "txBestBlocksState";
          txHash: string;
          found: boolean;
          ok?: boolean;
          events?: unknown[];
          block?: { hash: string; number: number; index: number };
          dispatchError?: unknown;
      }
    | {
          type: "finalized";
          txHash: string;
          ok: boolean;
          events: unknown[];
          block: { hash: string; number: number; index: number };
          dispatchError?: unknown;
      };
