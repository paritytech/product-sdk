import type { PolkadotSigner } from "polkadot-api";
import { createLogger } from "@parity/product-sdk-logger";

import { TxBatchError } from "./errors.js";
import { submitAndWatch } from "./submit.js";
import type {
    BatchApi,
    BatchSubmitOptions,
    BatchableCall,
    SubmittableTransaction,
    TxResult,
} from "./types.js";

const log = createLogger("tx:batch");

/**
 * Resolve a single call to its decoded call data.
 *
 * Handles three shapes:
 * 1. Ink SDK AsyncTransaction — has `.waited` Promise that resolves to a tx with `.decodedCall`
 * 2. PAPI transaction or object with `.decodedCall` — extract directly
 * 3. Raw decoded call — pass through as-is
 */
async function resolveDecodedCall(call: BatchableCall): Promise<unknown> {
    if (call != null && typeof call === "object") {
        const obj = call as Record<string, unknown>;

        // Handle Ink SDK AsyncTransaction: resolve .waited first
        if (
            "waited" in obj &&
            obj.waited &&
            typeof (obj.waited as Promise<unknown>).then === "function"
        ) {
            log.debug("Resolving Ink SDK AsyncTransaction in batch");
            const resolved = (await obj.waited) as Record<string, unknown>;
            if (resolved.decodedCall !== undefined) return resolved.decodedCall;
            throw new TxBatchError("Resolved AsyncTransaction has no decodedCall property");
        }

        // Handle SubmittableTransaction or object with decodedCall
        if ("decodedCall" in obj && obj.decodedCall !== undefined) {
            return obj.decodedCall;
        }
    }

    // Reject null, undefined, and primitives — they will cause cryptic codec errors on-chain
    if (call == null || typeof call !== "object") {
        throw new TxBatchError(
            `Invalid batch call: expected a transaction or decoded call object, got ${call === null ? "null" : typeof call}`,
        );
    }

    // Raw decoded call object — pass through
    return call;
}

/**
 * Batch multiple transactions into a single Substrate Utility batch and submit.
 *
 * Extracts `.decodedCall` from each transaction (handling Ink SDK `AsyncTransaction`
 * wrappers), wraps them in `Utility.batch_all` (or `batch`/`force_batch` via the
 * `mode` option), and submits via {@link submitAndWatch} with full lifecycle tracking.
 *
 * @param calls - Array of transactions, AsyncTransactions, or raw decoded calls to batch.
 * @param api - A typed API with `tx.Utility.batch_all/batch/force_batch`. Works with any
 *   chain that has the Utility pallet — no chain-specific imports required.
 *   **All calls must target the same chain as this API.** Do not mix decoded calls
 *   from different chains (e.g., Asset Hub and Bulletin) in a single batch.
 * @param signer - The signer to use. Can come from the Host API
 *   (`getProductAccountSigner`) or {@link createDevSigner}.
 * @param options - Optional {@link BatchSubmitOptions} (extends `SubmitOptions` with `mode`).
 * @returns The transaction result from the batch submission.
 *
 * @throws {TxBatchError} If `calls` is empty.
 * @throws {TxBatchError} If an AsyncTransaction resolves without a `.decodedCall` property.
 * @throws {TxTimeoutError} If the batch transaction does not reach the target state within `timeoutMs`.
 * @throws {TxDispatchError} If the on-chain dispatch fails.
 * @throws {TxSigningRejectedError} If the user rejects signing in their wallet.
 *
 * @example
 * ```ts
 * import { batchSubmitAndWatch } from "@parity/product-sdk-tx";
 *
 * const tx1 = api.tx.Balances.transfer_keep_alive({ dest: addr1, value: 1_000n });
 * const tx2 = api.tx.Balances.transfer_keep_alive({ dest: addr2, value: 2_000n });
 *
 * const result = await batchSubmitAndWatch([tx1, tx2], api, signer, {
 *   onStatus: (status) => console.log(status),
 * });
 * ```
 */
export async function batchSubmitAndWatch(
    calls: BatchableCall[],
    api: BatchApi,
    signer: PolkadotSigner,
    options?: BatchSubmitOptions,
): Promise<TxResult> {
    if (calls.length === 0) {
        throw new TxBatchError("Cannot batch zero calls");
    }

    const mode = options?.mode ?? "batch_all";

    log.info("Resolving batch calls", { count: calls.length, mode });
    const decodedCalls = await Promise.all(calls.map(resolveDecodedCall));

    log.info("Constructing batch transaction", { mode, callCount: decodedCalls.length });
    const batchTx = api.tx.Utility[mode]({ calls: decodedCalls });

    return submitAndWatch(batchTx, signer, options);
}

if (import.meta.vitest) {
    const { describe, test, expect, vi, beforeEach } = import.meta.vitest;
    const { configure } = await import("@parity/product-sdk-logger");
    const { TxDispatchError, TxSigningRejectedError } = await import("./errors.js");
    type TxEvent = import("./types.js").TxEvent;

    // Silence logger during tests
    beforeEach(() => {
        configure({ handler: () => {} });
    });

    type MockSubscribeHandlers = {
        next: (event: TxEvent) => void;
        error: (error: Error) => void;
    };

    function createMockTx(
        emitFn: (handlers: MockSubscribeHandlers) => void,
        decodedCall?: unknown,
    ): SubmittableTransaction {
        return {
            signSubmitAndWatch: (_signer: PolkadotSigner, _options?: unknown) => ({
                subscribe: (handlers: MockSubscribeHandlers) => {
                    const unsub = vi.fn();
                    queueMicrotask(() => emitFn(handlers));
                    return { unsubscribe: unsub };
                },
            }),
            decodedCall,
        };
    }

    const mockSigner = {} as PolkadotSigner;

    const signedEvent: TxEvent = { type: "signed", txHash: "0xbatch" };
    const bestBlockOk: TxEvent = {
        type: "txBestBlocksState",
        txHash: "0xbatch",
        found: true,
        ok: true,
        events: [{ id: 1 }],
        block: { hash: "0xblock1", number: 100, index: 0 },
    };

    function createMockBatchApi(emitFn: (handlers: MockSubscribeHandlers) => void): {
        api: BatchApi;
        getCapturedCalls: () => unknown[][];
    } {
        const capturedCalls: unknown[][] = [];

        const api: BatchApi = {
            tx: {
                Utility: {
                    batch: vi.fn((args: { calls: unknown[] }) => {
                        capturedCalls.push(args.calls);
                        return createMockTx(emitFn);
                    }) as BatchApi["tx"]["Utility"]["batch"],
                    batch_all: vi.fn((args: { calls: unknown[] }) => {
                        capturedCalls.push(args.calls);
                        return createMockTx(emitFn);
                    }) as BatchApi["tx"]["Utility"]["batch_all"],
                    force_batch: vi.fn((args: { calls: unknown[] }) => {
                        capturedCalls.push(args.calls);
                        return createMockTx(emitFn);
                    }) as BatchApi["tx"]["Utility"]["force_batch"],
                },
            },
        };

        return { api, getCapturedCalls: () => capturedCalls };
    }

    const successEmit = (h: MockSubscribeHandlers) => {
        h.next(signedEvent);
        h.next(bestBlockOk);
    };

    describe("batchSubmitAndWatch", () => {
        test("batches multiple transactions with decodedCall", async () => {
            const { api, getCapturedCalls } = createMockBatchApi(successEmit);
            const calls = [
                { decodedCall: { pallet: "Balances", method: "transfer", args: { value: 1 } } },
                { decodedCall: { pallet: "Balances", method: "transfer", args: { value: 2 } } },
            ];

            const result = await batchSubmitAndWatch(calls, api, mockSigner);

            expect(result.ok).toBe(true);
            expect(getCapturedCalls()).toHaveLength(1);
            expect(getCapturedCalls()[0]).toEqual([
                { pallet: "Balances", method: "transfer", args: { value: 1 } },
                { pallet: "Balances", method: "transfer", args: { value: 2 } },
            ]);
            expect(api.tx.Utility.batch_all).toHaveBeenCalledOnce();
        });

        test("handles Ink SDK AsyncTransaction wrappers", async () => {
            const { api, getCapturedCalls } = createMockBatchApi(successEmit);
            const asyncCall = {
                waited: Promise.resolve({ decodedCall: { pallet: "Contracts", method: "call" } }),
                signSubmitAndWatch: () => {
                    throw new Error("Should not be called");
                },
            };

            const result = await batchSubmitAndWatch([asyncCall], api, mockSigner);

            expect(result.ok).toBe(true);
            expect(getCapturedCalls()[0]).toEqual([{ pallet: "Contracts", method: "call" }]);
        });

        test("accepts raw decoded calls (pass-through)", async () => {
            const { api, getCapturedCalls } = createMockBatchApi(successEmit);
            const rawCall = { pallet: "System", method: "remark" };

            const result = await batchSubmitAndWatch([rawCall], api, mockSigner);

            expect(result.ok).toBe(true);
            expect(getCapturedCalls()[0]).toEqual([{ pallet: "System", method: "remark" }]);
        });

        test("mixes transaction types in a single batch", async () => {
            const { api, getCapturedCalls } = createMockBatchApi(successEmit);
            const txWithDecoded = { decodedCall: "call1" };
            const asyncTx = {
                waited: Promise.resolve({ decodedCall: "call2" }),
                signSubmitAndWatch: () => {
                    throw new Error("Should not be called");
                },
            };
            const rawCall = { pallet: "System", method: "remark" };

            const result = await batchSubmitAndWatch(
                [txWithDecoded, asyncTx, rawCall],
                api,
                mockSigner,
            );

            expect(result.ok).toBe(true);
            expect(getCapturedCalls()[0]).toEqual([
                "call1",
                "call2",
                { pallet: "System", method: "remark" },
            ]);
        });

        test("throws TxBatchError for empty calls array", async () => {
            const { api } = createMockBatchApi(successEmit);
            await expect(batchSubmitAndWatch([], api, mockSigner)).rejects.toThrow(TxBatchError);
            await expect(batchSubmitAndWatch([], api, mockSigner)).rejects.toThrow(
                "Cannot batch zero calls",
            );
        });

        test("throws TxBatchError when AsyncTransaction resolves without decodedCall", async () => {
            const { api } = createMockBatchApi(successEmit);
            const badAsync = {
                waited: Promise.resolve({ noDecodedCall: true }),
                signSubmitAndWatch: () => {
                    throw new Error("Should not be called");
                },
            };

            await expect(
                batchSubmitAndWatch([badAsync as unknown as BatchableCall], api, mockSigner),
            ).rejects.toThrow(TxBatchError);
        });

        test("throws TxBatchError for null call", async () => {
            const { api } = createMockBatchApi(successEmit);
            await expect(
                batchSubmitAndWatch([null as unknown as BatchableCall], api, mockSigner),
            ).rejects.toThrow(TxBatchError);
            await expect(
                batchSubmitAndWatch([null as unknown as BatchableCall], api, mockSigner),
            ).rejects.toThrow("Invalid batch call");
        });

        test("throws TxBatchError for primitive call", async () => {
            const { api } = createMockBatchApi(successEmit);
            await expect(
                batchSubmitAndWatch([42 as unknown as BatchableCall], api, mockSigner),
            ).rejects.toThrow(TxBatchError);
            await expect(
                batchSubmitAndWatch(["oops" as unknown as BatchableCall], api, mockSigner),
            ).rejects.toThrow("Invalid batch call");
        });

        test("treats { decodedCall: undefined } as raw pass-through object", async () => {
            const { api, getCapturedCalls } = createMockBatchApi(successEmit);
            const edgeCase = { decodedCall: undefined, other: "data" };

            const result = await batchSubmitAndWatch([edgeCase], api, mockSigner);

            expect(result.ok).toBe(true);
            // decodedCall is undefined so it falls through to raw pass-through
            expect(getCapturedCalls()[0]).toEqual([{ decodedCall: undefined, other: "data" }]);
        });

        test("defaults to batch_all mode", async () => {
            const { api } = createMockBatchApi(successEmit);
            await batchSubmitAndWatch([{ decodedCall: "call1" }], api, mockSigner);

            expect(api.tx.Utility.batch_all).toHaveBeenCalledOnce();
            expect(api.tx.Utility.batch).not.toHaveBeenCalled();
            expect(api.tx.Utility.force_batch).not.toHaveBeenCalled();
        });

        test("respects mode: batch", async () => {
            const { api } = createMockBatchApi(successEmit);
            await batchSubmitAndWatch([{ decodedCall: "call1" }], api, mockSigner, {
                mode: "batch",
            });

            expect(api.tx.Utility.batch).toHaveBeenCalledOnce();
            expect(api.tx.Utility.batch_all).not.toHaveBeenCalled();
        });

        test("respects mode: force_batch", async () => {
            const { api } = createMockBatchApi(successEmit);
            await batchSubmitAndWatch([{ decodedCall: "call1" }], api, mockSigner, {
                mode: "force_batch",
            });

            expect(api.tx.Utility.force_batch).toHaveBeenCalledOnce();
            expect(api.tx.Utility.batch_all).not.toHaveBeenCalled();
        });

        test("forwards SubmitOptions to submitAndWatch", async () => {
            const statuses: string[] = [];
            const { api } = createMockBatchApi(successEmit);

            await batchSubmitAndWatch([{ decodedCall: "call1" }], api, mockSigner, {
                onStatus: (s) => statuses.push(s),
            });

            expect(statuses).toContain("signing");
            expect(statuses).toContain("in-block");
        });

        test("propagates TxDispatchError", async () => {
            const { api } = createMockBatchApi((h) => {
                h.next(signedEvent);
                h.next({
                    type: "txBestBlocksState",
                    txHash: "0xbatch",
                    found: true,
                    ok: false,
                    events: [],
                    block: { hash: "0xblock1", number: 100, index: 0 },
                    dispatchError: {
                        type: "Module",
                        value: { type: "Utility", value: { type: "TooManyCalls" } },
                    },
                });
            });

            await expect(
                batchSubmitAndWatch([{ decodedCall: "call1" }], api, mockSigner),
            ).rejects.toThrow(TxDispatchError);
        });

        test("propagates TxSigningRejectedError", async () => {
            const { api } = createMockBatchApi((h) => {
                h.error(new Error("User rejected the request"));
            });

            await expect(
                batchSubmitAndWatch([{ decodedCall: "call1" }], api, mockSigner),
            ).rejects.toThrow(TxSigningRejectedError);
        });

        test("resolves all calls in parallel", async () => {
            const { api } = createMockBatchApi(successEmit);
            const resolveOrder: number[] = [];

            const asyncCall1 = {
                waited: new Promise<{ decodedCall: string }>((resolve) => {
                    setTimeout(() => {
                        resolveOrder.push(1);
                        resolve({ decodedCall: "call1" });
                    }, 10);
                }),
                signSubmitAndWatch: () => {
                    throw new Error("Should not be called");
                },
            };
            const asyncCall2 = {
                waited: new Promise<{ decodedCall: string }>((resolve) => {
                    setTimeout(() => {
                        resolveOrder.push(2);
                        resolve({ decodedCall: "call2" });
                    }, 5); // Resolves faster
                }),
                signSubmitAndWatch: () => {
                    throw new Error("Should not be called");
                },
            };

            await batchSubmitAndWatch([asyncCall1, asyncCall2], api, mockSigner);

            // Both should have resolved (order depends on timing, but both are present)
            expect(resolveOrder).toContain(1);
            expect(resolveOrder).toContain(2);
        });
    });
}
