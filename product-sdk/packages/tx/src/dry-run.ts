// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { type Result, err, ok } from "@parity/result";

import { TxDryRunError, formatDryRunError } from "./errors.js";
import type { SubmittableTransaction, Weight } from "./types.js";

/**
 * Validate an Ink SDK dry-run result and extract the submittable transaction.
 *
 * Replaces the 5-10 line boilerplate that every contract interaction repeats:
 * check `success`, parse the error, verify `send()` exists, and call it.
 *
 * Works with any object whose shape matches the Ink SDK contract query result
 * (typed structurally — no Ink SDK import required):
 *
 * - `contract.query("method", { origin, data })` (Ink SDK)
 * - `contract.write("method", args, origin)` (patched SDK wrappers)
 * - Any object with `{ success: boolean; value?: { send?(): ... } }`
 *
 * @param result - The dry-run result from a contract query or write simulation.
 * @returns A {@link Result}: `ok(SubmittableTransaction)` ready to pass to {@link submitAndWatch},
 *   or `err(TxDryRunError)` if the dry run failed, returned no value, or has no `send()`.
 *
 * @example
 * ```ts
 * import { extractTransaction, submitAndWatch, createDevSigner } from "@parity/product-sdk-tx";
 *
 * const dryRun = await contract.query("createItem", { origin, data: { name, price } });
 * const extracted = extractTransaction(dryRun);
 * if (!extracted.ok) return handle(extracted.error);
 * const result = await submitAndWatch(extracted.value, createDevSigner("Alice"));
 * ```
 */
export function extractTransaction(result: {
    success: boolean;
    value?: unknown;
    error?: unknown;
}): Result<SubmittableTransaction, TxDryRunError> {
    if (!result.success) {
        const formatted = formatDryRunError(result);
        const revertReason = extractRevertReason(result.value);
        return err(new TxDryRunError(result, formatted, revertReason));
    }

    const value = result.value;
    if (value == null || typeof value !== "object") {
        return err(new TxDryRunError(result, "dry run returned no value"));
    }

    const v = value as Record<string, unknown>;
    if (typeof v.send !== "function") {
        return err(new TxDryRunError(result, "not a write query (no send())"));
    }

    return ok(v.send() as SubmittableTransaction);
}

/**
 * Try to extract a revert reason string from a dry-run result value.
 * Returns `undefined` if no revert reason is available.
 */
function extractRevertReason(value: unknown): string | undefined {
    if (value == null || typeof value !== "object") return undefined;
    const v = value as Record<string, unknown>;

    if (typeof v.revertReason === "string" && v.revertReason) {
        return v.revertReason;
    }

    // Wrapped raw value (patched SDK)
    if ("raw" in v && v.raw != null && typeof v.raw === "object") {
        return extractRevertReason(v.raw);
    }

    return undefined;
}

/**
 * Apply a safety buffer to weight estimates from a dry-run result.
 *
 * Dry-run weight estimates reflect the exact execution cost at the time of
 * simulation. On-chain conditions can change between dry-run and actual
 * submission (storage growth, state changes by other transactions), so a
 * buffer prevents unexpected `OutOfGas` failures.
 *
 * The default 25% buffer matches the convention used across Polkadot
 * ecosystem tooling.
 *
 * @param weight - The `weight_required` from a `ReviveApi.call` or `ReviveApi.eth_transact` dry-run.
 * @param options - Override the buffer percentage (default: 25%).
 * @returns A new weight with both components scaled up.
 *
 * @example Basic usage with ReviveApi dry-run:
 * ```ts
 * const dryRun = await api.apis.ReviveApi.call(origin, dest, value, undefined, undefined, data);
 *
 * const tx = api.tx.Revive.call({
 *   dest, value, data,
 *   weight_limit: applyWeightBuffer(dryRun.weight_required),
 *   storage_deposit_limit: dryRun.storage_deposit.value,
 * });
 * ```
 *
 * @example Custom buffer for latency-sensitive operations:
 * ```ts
 * applyWeightBuffer(dryRun.weight_required, { percent: 50 });
 * ```
 */
export function applyWeightBuffer(weight: Weight, options?: { percent?: number }): Weight {
    const percent = options?.percent ?? 25;
    const multiplier = 100n + BigInt(percent);
    return {
        ref_time: (weight.ref_time * multiplier) / 100n,
        proof_size: (weight.proof_size * multiplier) / 100n,
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("extractTransaction", () => {
        /** Assert the result is `err` and return the narrowed `TxDryRunError`. */
        function expectErr(r: Result<SubmittableTransaction, TxDryRunError>): TxDryRunError {
            expect(r.ok).toBe(false);
            if (r.ok) throw new Error("expected err");
            return r.error;
        }

        test("returns ok(tx) from successful dry-run with send()", () => {
            const mockTx = {
                signSubmitAndWatch: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
            };
            const result = {
                success: true,
                value: { response: "ok", send: () => mockTx },
            };
            const extracted = extractTransaction(result);
            expect(extracted.ok).toBe(true);
            if (extracted.ok) expect(extracted.value).toBe(mockTx);
        });

        test("returns err(TxDryRunError) on failed dry-run", () => {
            const result = {
                success: false,
                value: { revertReason: "InsufficientBalance" },
            };
            const error = expectErr(extractTransaction(result));
            expect(error).toBeInstanceOf(TxDryRunError);
            expect(error.revertReason).toBe("InsufficientBalance");
            expect(error.formatted).toBe("InsufficientBalance");
            expect(error.message).toContain("InsufficientBalance");
            expect(error.raw).toBe(result);
        });

        test("err with Module error formatting", () => {
            const result = {
                success: false,
                value: {
                    type: "Module",
                    value: { type: "Revive", value: { type: "StorageDepositNotEnoughFunds" } },
                },
            };
            const error = expectErr(extractTransaction(result));
            expect(error.formatted).toBe("Revive.StorageDepositNotEnoughFunds");
            expect(error.revertReason).toBeUndefined();
        });

        test("err with error field", () => {
            const result = {
                success: false,
                value: {},
                error: { type: "ContractTrapped" },
            };
            const error = expectErr(extractTransaction(result));
            expect(error.formatted).toBe("ContractTrapped");
        });

        test("err when value is missing", () => {
            const result = { success: true };
            const error = expectErr(extractTransaction(result));
            expect(error).toBeInstanceOf(TxDryRunError);
        });

        test("err when send is not a function", () => {
            const result = { success: true, value: { response: "ok" } };
            const error = expectErr(extractTransaction(result));
            expect(error.message).toContain("not a write query");
        });

        test("err with revertReason from nested raw (patched SDK)", () => {
            const result = {
                success: false,
                value: { raw: { revertReason: "Unauthorized" } },
            };
            const error = expectErr(extractTransaction(result));
            expect(error.revertReason).toBe("Unauthorized");
        });

        test("err with ReviveApi Message error", () => {
            const result = {
                success: false,
                value: { type: "Message", value: "Insufficient balance for gas * price + value" },
            };
            const error = expectErr(extractTransaction(result));
            expect(error.formatted).toBe("Insufficient balance for gas * price + value");
        });
    });

    describe("applyWeightBuffer", () => {
        test("applies default 25% buffer", () => {
            const weight: Weight = { ref_time: 1000n, proof_size: 500n };
            const buffered = applyWeightBuffer(weight);
            expect(buffered.ref_time).toBe(1250n);
            expect(buffered.proof_size).toBe(625n);
        });

        test("applies custom buffer percentage", () => {
            const weight: Weight = { ref_time: 1000n, proof_size: 1000n };
            const buffered = applyWeightBuffer(weight, { percent: 50 });
            expect(buffered.ref_time).toBe(1500n);
            expect(buffered.proof_size).toBe(1500n);
        });

        test("zero buffer returns same values", () => {
            const weight: Weight = { ref_time: 1000n, proof_size: 500n };
            const buffered = applyWeightBuffer(weight, { percent: 0 });
            expect(buffered.ref_time).toBe(1000n);
            expect(buffered.proof_size).toBe(500n);
        });

        test("does not mutate original weight", () => {
            const weight: Weight = { ref_time: 1000n, proof_size: 500n };
            const buffered = applyWeightBuffer(weight);
            expect(weight.ref_time).toBe(1000n);
            expect(weight.proof_size).toBe(500n);
            expect(buffered).not.toBe(weight);
        });

        test("works with realistic weight values", () => {
            // Values from tick3t reference repo
            const weight: Weight = { ref_time: 4_500_000_000n, proof_size: 1_000_000n };
            const buffered = applyWeightBuffer(weight);
            expect(buffered.ref_time).toBe(5_625_000_000n);
            expect(buffered.proof_size).toBe(1_250_000n);
        });
    });
}
