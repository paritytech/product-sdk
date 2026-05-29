// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { PolkadotSigner } from "polkadot-api";
import { createLogger } from "@parity/product-sdk-logger";

import {
    TxDispatchError,
    TxSigningRejectedError,
    TxTimeoutError,
    formatDispatchError,
    isSigningRejection,
} from "./errors.js";
import type { SubmitOptions, SubmittableTransaction, TxEvent, TxResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MORTALITY_PERIOD = 256;

const log = createLogger("tx");

/**
 * Resolve Ink SDK AsyncTransaction wrappers.
 *
 * Ink SDK's `contract.send()` returns an object with a `.waited` Promise that
 * resolves to the actual transaction. This handles that transparently.
 */
async function resolveTransaction(tx: SubmittableTransaction): Promise<SubmittableTransaction> {
    if (tx.waited && typeof tx.waited.then === "function") {
        log.debug("Resolving Ink SDK AsyncTransaction");
        return tx.waited;
    }
    return tx;
}

function buildTxResult(
    event: TxEvent & { ok: boolean; block: TxResult["block"]; events: unknown[] },
): TxResult {
    return {
        txHash: event.txHash,
        ok: event.ok,
        block: event.block,
        events: event.events,
        dispatchError: "dispatchError" in event ? event.dispatchError : undefined,
    };
}

/**
 * Submit a transaction and watch its lifecycle through signing, broadcasting,
 * block inclusion, and (optionally) finalization.
 *
 * @param tx - A transaction object with `signSubmitAndWatch`. Works with raw PAPI
 *   transactions and Ink SDK `AsyncTransaction` wrappers (resolved automatically).
 * @param signer - The signer to use. Can come from the Host API
 *   (`getProductAccountSigner`) or {@link createDevSigner}.
 * @param options - Submission options (waitFor, timeout, mortality, status callback).
 * @returns The transaction result once included/finalized.
 *
 * @throws {TxTimeoutError} If the transaction does not reach the target state within `timeoutMs`.
 * @throws {TxDispatchError} If the on-chain dispatch fails (e.g., insufficient balance, contract revert).
 * @throws {TxSigningRejectedError} If the user rejects signing in their wallet.
 */
export async function submitAndWatch(
    tx: SubmittableTransaction,
    signer: PolkadotSigner,
    options?: SubmitOptions,
): Promise<TxResult> {
    const waitFor = options?.waitFor ?? "best-block";
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const mortalityPeriod = options?.mortalityPeriod ?? DEFAULT_MORTALITY_PERIOD;
    const onStatus = options?.onStatus;

    const resolvedTx = await resolveTransaction(tx);

    return new Promise<TxResult>((resolve, reject) => {
        let settled = false;
        let subscription: { unsubscribe: () => void } | null = null;

        const timer = setTimeout(() => {
            subscription?.unsubscribe();
            if (!settled) {
                settled = true;
                onStatus?.("error");
                reject(new TxTimeoutError(timeoutMs));
            }
        }, timeoutMs);

        function teardown(): void {
            clearTimeout(timer);
            subscription?.unsubscribe();
        }

        function settleReject(error: Error): void {
            if (settled) return;
            settled = true;
            teardown();
            onStatus?.("error");
            reject(error);
        }

        try {
            const observable = resolvedTx.signSubmitAndWatch(signer, {
                mortality: { mortal: true, period: mortalityPeriod },
            });

            subscription = observable.subscribe({
                next: (event: TxEvent) => {
                    switch (event.type) {
                        case "signed": {
                            log.info("Transaction signed", { txHash: event.txHash });
                            onStatus?.("signing");
                            break;
                        }
                        case "broadcasted": {
                            log.info("Transaction broadcasted", { txHash: event.txHash });
                            onStatus?.("broadcasting");
                            break;
                        }
                        case "txBestBlocksState": {
                            if (!event.found) break;

                            if (event.ok === false) {
                                const formatted = formatDispatchError({
                                    ok: false,
                                    dispatchError: event.dispatchError,
                                });
                                log.error("Transaction failed in best block", {
                                    formatted,
                                    block: event.block,
                                });
                                settleReject(new TxDispatchError(event.dispatchError, formatted));
                                return;
                            }

                            log.info("Transaction in best block", { block: event.block });
                            onStatus?.("in-block");

                            if (
                                waitFor === "best-block" &&
                                event.ok === true &&
                                event.block &&
                                event.events
                            ) {
                                // Resolve the Promise but keep the subscription alive so we can
                                // detect reorgs (finalized event with ok=false after best-block ok=true).
                                // Only clear the timer since the consumer has their result.
                                settled = true;
                                clearTimeout(timer);
                                resolve(
                                    buildTxResult(
                                        event as TxEvent & {
                                            ok: boolean;
                                            block: TxResult["block"];
                                            events: unknown[];
                                        },
                                    ),
                                );
                            }
                            break;
                        }
                        case "finalized": {
                            log.info("Transaction finalized", { ok: event.ok, block: event.block });

                            if (!event.ok) {
                                const formatted = formatDispatchError({
                                    ok: false,
                                    dispatchError: event.dispatchError,
                                });

                                if (settled) {
                                    // Already resolved at best-block but finalized shows failure
                                    // due to a chain reorganization. We can only log since the
                                    // Promise is already resolved.
                                    log.warn(
                                        "Transaction failed after being in best block (reorg). " +
                                            "The consumer received a success result that is no longer valid.",
                                        { formatted, block: event.block },
                                    );
                                } else {
                                    settleReject(
                                        new TxDispatchError(event.dispatchError, formatted),
                                    );
                                }
                                subscription?.unsubscribe();
                                return;
                            }

                            onStatus?.("finalized");

                            if (!settled) {
                                settled = true;
                                teardown();
                                resolve(buildTxResult(event));
                            } else {
                                // Already resolved at best-block, finalization confirmed success.
                                subscription?.unsubscribe();
                            }
                            break;
                        }
                    }
                },
                error: (err: Error) => {
                    log.error("Transaction subscription error", { error: err.message });

                    if (isSigningRejection(err)) {
                        settleReject(new TxSigningRejectedError());
                    } else {
                        settleReject(err);
                    }
                },
            });
        } catch (err) {
            log.error("Failed to start transaction", { error: (err as Error).message });
            teardown();

            if (isSigningRejection(err)) {
                settleReject(new TxSigningRejectedError());
            } else {
                settleReject(err as Error);
            }
        }
    });
}

if (import.meta.vitest) {
    const { describe, test, expect, vi, beforeEach } = import.meta.vitest;
    const { configure } = await import("@parity/product-sdk-logger");

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
    ): SubmittableTransaction {
        return {
            signSubmitAndWatch: (_signer: PolkadotSigner, _options?: unknown) => ({
                subscribe: (handlers: MockSubscribeHandlers) => {
                    const unsub = vi.fn();
                    // Emit events asynchronously so the subscription is returned first
                    queueMicrotask(() => emitFn(handlers));
                    return { unsubscribe: unsub };
                },
            }),
        };
    }

    const mockSigner = {} as PolkadotSigner;

    const signedEvent: TxEvent = { type: "signed", txHash: "0xabc" };
    const broadcastedEvent: TxEvent = { type: "broadcasted", txHash: "0xabc" };
    const bestBlockOk: TxEvent = {
        type: "txBestBlocksState",
        txHash: "0xabc",
        found: true,
        ok: true,
        events: [{ id: 1 }],
        block: { hash: "0xblock1", number: 100, index: 0 },
    };
    const bestBlockFail: TxEvent = {
        type: "txBestBlocksState",
        txHash: "0xabc",
        found: true,
        ok: false,
        events: [],
        block: { hash: "0xblock1", number: 100, index: 0 },
        dispatchError: {
            type: "Module",
            value: { type: "Balances", value: { type: "InsufficientBalance" } },
        },
    };
    const finalizedOk: TxEvent = {
        type: "finalized",
        txHash: "0xabc",
        ok: true,
        events: [{ id: 1 }],
        block: { hash: "0xblock2", number: 101, index: 0 },
    };
    const finalizedFail: TxEvent = {
        type: "finalized",
        txHash: "0xabc",
        ok: false,
        events: [],
        block: { hash: "0xblock2", number: 101, index: 0 },
        dispatchError: { type: "BadOrigin" },
    };

    describe("submitAndWatch", () => {
        test("resolves at best-block by default", async () => {
            const tx = createMockTx((h) => {
                h.next(signedEvent);
                h.next(broadcastedEvent);
                h.next(bestBlockOk);
                h.next(finalizedOk);
            });
            const result = await submitAndWatch(tx, mockSigner);
            expect(result.ok).toBe(true);
            expect(result.block.number).toBe(100);
        });

        test("resolves at finalized when configured", async () => {
            const tx = createMockTx((h) => {
                h.next(signedEvent);
                h.next(bestBlockOk);
                h.next(finalizedOk);
            });
            const result = await submitAndWatch(tx, mockSigner, { waitFor: "finalized" });
            expect(result.ok).toBe(true);
            expect(result.block.number).toBe(101);
        });

        test("rejects with TxDispatchError on best-block failure", async () => {
            const tx = createMockTx((h) => {
                h.next(signedEvent);
                h.next(bestBlockFail);
            });
            await expect(submitAndWatch(tx, mockSigner)).rejects.toThrow(TxDispatchError);
        });

        test("rejects with TxDispatchError on finalized failure", async () => {
            const tx = createMockTx((h) => {
                h.next(signedEvent);
                h.next(finalizedFail);
            });
            await expect(submitAndWatch(tx, mockSigner, { waitFor: "finalized" })).rejects.toThrow(
                TxDispatchError,
            );
        });

        test("rejects with TxTimeoutError after timeout", async () => {
            const tx = createMockTx(() => {
                // Never emits any events - tx hangs forever
            });
            const error = await submitAndWatch(tx, mockSigner, { timeoutMs: 50 }).catch(
                (e: unknown) => e,
            );
            expect(error).toBeInstanceOf(TxTimeoutError);
            expect((error as TxTimeoutError).timeoutMs).toBe(50);
        });

        test("calls onStatus callbacks in order", async () => {
            const statuses: string[] = [];
            const tx = createMockTx((h) => {
                h.next(signedEvent);
                h.next(broadcastedEvent);
                h.next(bestBlockOk);
            });
            await submitAndWatch(tx, mockSigner, {
                onStatus: (s) => statuses.push(s),
            });
            expect(statuses).toEqual(["signing", "broadcasting", "in-block"]);
        });

        test("resolves Ink SDK AsyncTransaction", async () => {
            const innerTx = createMockTx((h) => {
                h.next(signedEvent);
                h.next(bestBlockOk);
            });
            const wrappedTx: SubmittableTransaction = {
                signSubmitAndWatch: () => {
                    throw new Error("Should not be called on outer tx");
                },
                waited: Promise.resolve(innerTx),
            };
            const result = await submitAndWatch(wrappedTx, mockSigner);
            expect(result.ok).toBe(true);
        });

        test("passes mortality options", async () => {
            let capturedOptions: unknown;
            const tx: SubmittableTransaction = {
                signSubmitAndWatch: (_signer: PolkadotSigner, options?: unknown) => {
                    capturedOptions = options;
                    return {
                        subscribe: (handlers: MockSubscribeHandlers) => {
                            queueMicrotask(() => {
                                handlers.next(signedEvent);
                                handlers.next(bestBlockOk);
                            });
                            return { unsubscribe: vi.fn() };
                        },
                    };
                },
            };
            await submitAndWatch(tx, mockSigner, { mortalityPeriod: 512 });
            expect(capturedOptions).toEqual({ mortality: { mortal: true, period: 512 } });
        });

        test("wraps signing rejection in TxSigningRejectedError", async () => {
            const tx = createMockTx((h) => {
                h.error(new Error("User rejected the request"));
            });
            await expect(submitAndWatch(tx, mockSigner)).rejects.toThrow(TxSigningRejectedError);
        });

        test("skips txBestBlocksState with found=false", async () => {
            const tx = createMockTx((h) => {
                h.next(signedEvent);
                h.next({
                    type: "txBestBlocksState",
                    txHash: "0xabc",
                    found: false,
                });
                h.next(bestBlockOk);
            });
            const result = await submitAndWatch(tx, mockSigner);
            expect(result.ok).toBe(true);
        });

        test("rejects with original error for non-rejection Observable errors", async () => {
            const tx = createMockTx((h) => {
                h.error(new Error("WebSocket disconnected"));
            });
            const err = await submitAndWatch(tx, mockSigner).catch((e) => e);
            expect(err.message).toBe("WebSocket disconnected");
            expect(err).not.toBeInstanceOf(TxSigningRejectedError);
        });

        test("handles synchronous throw from signSubmitAndWatch", async () => {
            const tx: SubmittableTransaction = {
                signSubmitAndWatch: () => {
                    throw new Error("Signer not available");
                },
            };
            await expect(submitAndWatch(tx, mockSigner)).rejects.toThrow("Signer not available");
        });

        test("calls onStatus error on dispatch failure", async () => {
            const statuses: string[] = [];
            const tx = createMockTx((h) => {
                h.next(bestBlockFail);
            });
            await submitAndWatch(tx, mockSigner, {
                onStatus: (s) => statuses.push(s),
            }).catch(() => {});
            expect(statuses).toContain("error");
        });

        test("logs warning on reorg (best-block ok, finalized fail)", async () => {
            const warnings: unknown[] = [];
            const { configure: configureLogs } = await import("@parity/product-sdk-logger");
            configureLogs({
                level: "debug",
                handler: (entry) => {
                    if (entry.level === "warn") warnings.push(entry.message);
                },
            });

            const tx = createMockTx((h) => {
                h.next(signedEvent);
                h.next(bestBlockOk);
                // Finalized says the tx actually failed (reorg)
                h.next(finalizedFail);
            });

            // Should resolve at best-block (success)
            const result = await submitAndWatch(tx, mockSigner);
            expect(result.ok).toBe(true);

            // Give the finalized event time to fire and log
            await new Promise((r) => setTimeout(r, 10));

            expect(warnings.some((w) => typeof w === "string" && w.includes("reorg"))).toBe(true);

            // Restore silent handler
            configureLogs({ handler: () => {} });
        });

        test("does not resolve when txBestBlocksState ok is undefined", async () => {
            const tx = createMockTx((h) => {
                h.next(signedEvent);
                // ok is undefined (not explicitly true or false)
                h.next({
                    type: "txBestBlocksState",
                    txHash: "0xabc",
                    found: true,
                    events: [{ id: 1 }],
                    block: { hash: "0xblock1", number: 100, index: 0 },
                    // ok intentionally omitted
                } as TxEvent);
                // Should only resolve when finalized
                h.next(finalizedOk);
            });

            const result = await submitAndWatch(tx, mockSigner);
            // Should resolve from finalized, not best-block (since ok was undefined)
            expect(result.block.number).toBe(101);
        });
    });
}
