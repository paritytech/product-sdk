// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test fakes for `@parity/product-sdk-contracts`.
 *
 * `createFakeContractRuntime` is an in-memory `ContractRuntime` for
 * `createContract(runtime, address, abi)` — test `.query()` / `.prepare()` with
 * no chain and no deployed contract. `fakeDryRunResult` builds the fiddly
 * `ReviveDryRunResult` when you need full control over reverts / failures.
 *
 * @packageDocumentation
 */
import {
    type Abi as ViemAbi,
    bytesToHex,
    decodeFunctionData,
    encodeFunctionResult,
    hexToBytes,
} from "viem";
import type { HexString, SS58String } from "polkadot-api";
import type { SubmittableTransaction, Weight } from "@parity/product-sdk-tx";

import type { ContractRuntime, ReviveDryRunResult, ReviveTypedApi } from "./runtime.js";
import type { AbiEntry } from "./types.js";

/** pallet-revive sets bit 0 of `flags` when a call reverts (mirror of wrap.ts). */
const REVERT_FLAG = 1;

const textEncoder = new TextEncoder();

/** Options for {@link fakeDryRunResult}. */
export interface FakeDryRunResultOptions {
    /** Raw ABI-encoded return bytes. Ignored when the runtime encodes for you. */
    data?: Uint8Array;
    /** Simulate a revert: `true` for an empty reason, a string for a UTF-8 reason. Sets the revert flag. */
    revert?: boolean | string;
    /** Simulate a dispatch failure (`result.success: false`) carrying this payload. */
    failure?: unknown;
    /** Weight surfaced as a query's `gasRequired`. Default `{ ref_time: 1n, proof_size: 1n }`. */
    weightRequired?: Weight;
}

/**
 * Build a {@link ReviveDryRunResult}. Defaults to a successful, empty return;
 * pass `data` for a raw payload, `revert` for a revert, or `failure` for a
 * dispatch error.
 */
export function fakeDryRunResult(options?: FakeDryRunResultOptions): ReviveDryRunResult {
    const base = {
        weight_consumed: { ref_time: 0n, proof_size: 0n },
        weight_required: options?.weightRequired ?? { ref_time: 1n, proof_size: 1n },
        storage_deposit: { type: "Refund" as const, value: 0n },
        max_storage_deposit: { type: "Refund" as const, value: 0n },
        gas_consumed: 0n,
    };
    if (options?.failure !== undefined) {
        return { ...base, result: { success: false, value: options.failure } };
    }
    if (options?.revert !== undefined && options.revert !== false) {
        const reason = typeof options.revert === "string" ? options.revert : "";
        return {
            ...base,
            result: {
                success: true,
                value: { flags: REVERT_FLAG, data: textEncoder.encode(reason) },
            },
        };
    }
    return {
        ...base,
        result: { success: true, value: { flags: 0, data: options?.data ?? new Uint8Array(0) } },
    };
}

function isDryRunResult(value: unknown): value is ReviveDryRunResult {
    return (
        typeof value === "object" &&
        value !== null &&
        "result" in value &&
        "weight_required" in value
    );
}

/** The dry-run / query a fake runtime was asked to perform. */
export interface DecodedContractCall {
    origin: SS58String;
    dest: HexString;
    value: bigint;
    data: Uint8Array;
    /** Decoded function name — present only when `abi` was supplied. */
    functionName?: string;
    /** Decoded arguments — present only when `abi` was supplied. */
    args?: unknown[];
}

/** The extrinsic a fake runtime was asked to build via `.tx()` / `.prepare()`. */
export interface BuiltContractCall {
    dest: HexString;
    value: bigint;
    weight_limit: Weight;
    storage_deposit_limit: bigint;
    data: Uint8Array;
}

/** A fake {@link ContractRuntime} with an inspection surface for tests. */
export interface FakeContractRuntime extends ContractRuntime {
    /** Every dry-run / query the runtime handled, in order. */
    readonly calls: ReadonlyArray<DecodedContractCall>;
    /** Clear the recorded calls. */
    reset(): void;
}

/** Options for {@link createFakeContractRuntime}. */
export interface CreateFakeContractRuntimeOptions {
    /**
     * ABI used to decode inbound calldata (so `onQuery` gets `functionName` /
     * `args`) and to encode a value `onQuery` returns. Omit only if `onQuery`
     * returns raw bytes or a {@link fakeDryRunResult}.
     */
    abi?: AbiEntry[];
    /**
     * Handle each query / dry-run. Return the value to decode to (encoded via
     * `abi`), raw bytes, or a {@link fakeDryRunResult}. Default: empty success.
     */
    onQuery?: (call: DecodedContractCall) => unknown;
    /** Called with the extrinsic `.tx()` / `.prepare()` builds. */
    onCall?: (call: BuiltContractCall) => void;
}

/**
 * Create an in-memory {@link ContractRuntime}.
 *
 * @example
 * ```ts
 * import { createContract } from "@parity/product-sdk-contracts";
 * import { createFakeContractRuntime } from "@parity/product-sdk-contracts/testing";
 *
 * const runtime = createFakeContractRuntime({
 *   abi: erc20Abi,
 *   onQuery: ({ functionName }) => (functionName === "balanceOf" ? 1000n : 0n),
 * });
 * const token = createContract(runtime, ADDRESS, erc20Abi);
 * const { value } = await token.balanceOf.query(HOLDER); // 1000n
 * ```
 */
export function createFakeContractRuntime(
    options?: CreateFakeContractRuntimeOptions,
): FakeContractRuntime {
    const abi = options?.abi;
    const calls: DecodedContractCall[] = [];

    const dryRunCall: ContractRuntime["dryRunCall"] = async (
        origin,
        dest,
        value,
        _gasLimit,
        _storageDepositLimit,
        data,
    ) => {
        let functionName: string | undefined;
        let args: unknown[] | undefined;
        if (abi) {
            const decoded = decodeFunctionData({
                abi: abi as unknown as ViemAbi,
                data: bytesToHex(data),
            });
            functionName = decoded.functionName;
            args = decoded.args ? [...decoded.args] : [];
        }
        const call: DecodedContractCall = { origin, dest, value, data, functionName, args };
        calls.push(call);

        const out = options?.onQuery ? options.onQuery(call) : undefined;
        if (isDryRunResult(out)) return out;
        if (out instanceof Uint8Array) return fakeDryRunResult({ data: out });
        if (out === undefined) return fakeDryRunResult();

        if (!abi || !functionName) {
            throw new Error(
                "createFakeContractRuntime: onQuery returned a value but no abi is set to encode it. Pass `abi`, or return a Uint8Array or fakeDryRunResult().",
            );
        }
        const encoded = hexToBytes(
            encodeFunctionResult({
                abi: abi as unknown as ViemAbi,
                functionName,
                result: out,
            }),
        );
        return fakeDryRunResult({ data: encoded });
    };

    const api: ReviveTypedApi = {
        tx: {
            Revive: {
                call: (built) => {
                    options?.onCall?.(built);
                    return {} as unknown as SubmittableTransaction;
                },
                map_account: () => ({}) as unknown as SubmittableTransaction,
            },
        },
        query: { Revive: { OriginalAccount: { getValue: async () => undefined } } },
        apis: {
            ReviveApi: {
                // Same signature as dryRunCall (it ignores the 7th `options` arg).
                call: dryRunCall,
            },
        },
    };

    return {
        api,
        dryRunCall,
        calls,
        reset() {
            calls.length = 0;
        },
    } satisfies FakeContractRuntime;
}

if (import.meta.vitest) {
    // Round-trip guard: drive the fake through the *real* createContract.
    const { describe, test, expect } = import.meta.vitest;
    const { createContract } = await import("./manager.js");

    const abi: AbiEntry[] = [
        {
            type: "function",
            name: "balanceOf",
            stateMutability: "view",
            inputs: [{ name: "owner", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
        },
        {
            type: "function",
            name: "transfer",
            stateMutability: "nonpayable",
            inputs: [
                { name: "to", type: "address" },
                { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
        },
    ];

    const CONTRACT = `0x${"22".repeat(20)}` as HexString;
    const HOLDER = `0x${"11".repeat(20)}` as HexString;

    // Minimal typed handle for the two ABI methods above.
    type TestToken = {
        balanceOf: {
            query: (
                owner: HexString,
            ) => Promise<{ success: true; value: bigint } | { success: false; value: unknown }>;
        };
        transfer: {
            prepare: (
                to: HexString,
                amount: bigint,
                opts?: { gasLimit?: Weight; storageDepositLimit?: bigint },
            ) => Promise<unknown>;
        };
    };
    const makeToken = (runtime: ContractRuntime) =>
        createContract(runtime, CONTRACT, abi) as unknown as TestToken;

    describe("createFakeContractRuntime", () => {
        test("query decodes a value the runtime encodes from onQuery", async () => {
            const runtime = createFakeContractRuntime({
                abi,
                onQuery: ({ functionName }) => (functionName === "balanceOf" ? 1000n : 0n),
            });
            const token = makeToken(runtime);

            const res = await token.balanceOf.query(HOLDER);
            expect(res.success).toBe(true);
            if (res.success) expect(res.value).toBe(1000n);
            expect(runtime.calls[0]?.functionName).toBe("balanceOf");
        });

        test("query surfaces a revert as success:false", async () => {
            const runtime = createFakeContractRuntime({
                abi,
                onQuery: () => fakeDryRunResult({ revert: "InsufficientBalance" }),
            });
            const res = await makeToken(runtime).balanceOf.query(HOLDER);
            expect(res.success).toBe(false);
        });

        test("query surfaces a dispatch failure with its payload", async () => {
            const runtime = createFakeContractRuntime({
                abi,
                onQuery: () => fakeDryRunResult({ failure: { type: "AccountNotMapped" } }),
            });
            const res = await makeToken(runtime).balanceOf.query(HOLDER);
            expect(res.success).toBe(false);
            expect(res.value).toEqual({ type: "AccountNotMapped" });
        });

        test("prepare builds an extrinsic that onCall captures", async () => {
            let captured: BuiltContractCall | undefined;
            const runtime = createFakeContractRuntime({
                abi,
                onCall: (c) => {
                    captured = c;
                },
            });
            // Supply both limits so the sizing dry-run is skipped (no origin needed).
            await makeToken(runtime).transfer.prepare(HOLDER, 5n, {
                gasLimit: { ref_time: 100n, proof_size: 200n },
                storageDepositLimit: 0n,
            });

            expect(captured?.dest).toBe(CONTRACT);
            expect(captured?.value).toBe(0n);
            expect(captured?.weight_limit).toEqual({ ref_time: 100n, proof_size: 200n });
            expect(captured?.data).toBeInstanceOf(Uint8Array);
        });
    });
}
