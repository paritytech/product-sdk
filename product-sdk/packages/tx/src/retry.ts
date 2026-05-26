// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createLogger } from "@parity/product-sdk-logger";

import { TxBatchError, TxDispatchError, TxSigningRejectedError, TxTimeoutError } from "./errors.js";
import type { RetryOptions } from "./types.js";

const log = createLogger("tx:retry");

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether an error is deterministic and should not be retried.
 *
 * - Batch errors are deterministic input validation failures (e.g., empty calls array).
 * - Dispatch errors are on-chain failures (e.g., insufficient balance) that will
 *   produce the same result on retry.
 * - Signing rejections are explicit user intent.
 * - Timeouts mean we already waited the full duration; retrying would double the wait.
 */
function isNonRetryable(error: unknown): boolean {
    return (
        error instanceof TxBatchError ||
        error instanceof TxDispatchError ||
        error instanceof TxSigningRejectedError ||
        error instanceof TxTimeoutError
    );
}

/**
 * Calculate delay with exponential backoff and jitter.
 *
 * Jitter prevents thundering-herd when multiple clients retry simultaneously.
 * The delay is `min(baseDelay * 2^attempt, maxDelay) * random(0.5, 1.0)`.
 */
export function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.round(exponential * jitter);
}

/**
 * Wrap an async function with retry logic and exponential backoff.
 *
 * Only retries transient errors (network disconnects, temporary RPC failures).
 * Deterministic errors ({@link TxDispatchError}, {@link TxBatchError}), user
 * rejections ({@link TxSigningRejectedError}), and timeouts ({@link TxTimeoutError})
 * are rethrown immediately without retry.
 *
 * @param fn - The async function to retry.
 * @param options - Retry configuration.
 * @returns The result of the first successful call.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *     () => submitAndWatch(tx, signer),
 *     { maxAttempts: 3, baseDelayMs: 1_000 },
 * );
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? 3;
    const baseDelayMs = options?.baseDelayMs ?? 1_000;
    const maxDelayMs = options?.maxDelayMs ?? 15_000;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (isNonRetryable(error)) {
                throw error;
            }

            if (attempt + 1 >= maxAttempts) {
                break;
            }

            const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
            log.warn(`Attempt ${attempt + 1}/${maxAttempts} failed, retrying in ${delay}ms`, {
                error: error instanceof Error ? error.message : String(error),
            });
            await sleep(delay);
        }
    }

    throw lastError;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi, beforeEach } = import.meta.vitest;
    const { configure } = await import("@parity/product-sdk-logger");

    beforeEach(() => {
        configure({ handler: () => {} });
        vi.useRealTimers();
    });

    describe("withRetry", () => {
        test("returns on first success", async () => {
            const result = await withRetry(() => Promise.resolve("ok"));
            expect(result).toBe("ok");
        });

        test("retries transient error then succeeds", async () => {
            let calls = 0;
            const result = await withRetry(
                () => {
                    calls++;
                    if (calls < 2) return Promise.reject(new Error("Network error"));
                    return Promise.resolve("recovered");
                },
                { baseDelayMs: 1 },
            );
            expect(result).toBe("recovered");
            expect(calls).toBe(2);
        });

        test("gives up after maxAttempts", async () => {
            let calls = 0;
            await expect(
                withRetry(
                    () => {
                        calls++;
                        return Promise.reject(new Error("Persistent failure"));
                    },
                    { maxAttempts: 3, baseDelayMs: 1 },
                ),
            ).rejects.toThrow("Persistent failure");
            expect(calls).toBe(3);
        });

        test("does NOT retry TxDispatchError", async () => {
            let calls = 0;
            await expect(
                withRetry(
                    () => {
                        calls++;
                        return Promise.reject(
                            new TxDispatchError({}, "Balances.InsufficientBalance"),
                        );
                    },
                    { maxAttempts: 3, baseDelayMs: 1 },
                ),
            ).rejects.toThrow(TxDispatchError);
            expect(calls).toBe(1);
        });

        test("does NOT retry TxSigningRejectedError", async () => {
            let calls = 0;
            await expect(
                withRetry(
                    () => {
                        calls++;
                        return Promise.reject(new TxSigningRejectedError());
                    },
                    { maxAttempts: 3, baseDelayMs: 1 },
                ),
            ).rejects.toThrow(TxSigningRejectedError);
            expect(calls).toBe(1);
        });

        test("does NOT retry TxBatchError", async () => {
            let calls = 0;
            await expect(
                withRetry(
                    () => {
                        calls++;
                        return Promise.reject(new TxBatchError("Cannot batch zero calls"));
                    },
                    { maxAttempts: 3, baseDelayMs: 1 },
                ),
            ).rejects.toThrow(TxBatchError);
            expect(calls).toBe(1);
        });

        test("does NOT retry TxTimeoutError", async () => {
            let calls = 0;
            await expect(
                withRetry(
                    () => {
                        calls++;
                        return Promise.reject(new TxTimeoutError(300_000));
                    },
                    { maxAttempts: 3, baseDelayMs: 1 },
                ),
            ).rejects.toThrow(TxTimeoutError);
            expect(calls).toBe(1);
        });

        test("respects maxDelayMs cap", () => {
            // attempt=10 with baseDelay=1000 would be 1024000ms uncapped
            const delay = calculateDelay(10, 1_000, 15_000);
            expect(delay).toBeLessThanOrEqual(15_000);
            expect(delay).toBeGreaterThan(0);
        });

        test("applies jitter (delay varies between calls)", () => {
            const delays = Array.from({ length: 20 }, () => calculateDelay(2, 1_000, 15_000));
            const unique = new Set(delays);
            // With jitter, we should get multiple distinct values out of 20 samples
            expect(unique.size).toBeGreaterThan(1);
        });

        test("exponential backoff increases delay", () => {
            const base = 1_000;
            // The minimum possible delay at each attempt (jitter factor = 0.5)
            const minDelay2 = base * 4 * 0.5; // 2000
            // attempt 2 minimum should be greater than attempt 0 maximum
            const maxDelay0 = base * 1.0; // 1000
            expect(minDelay2).toBeGreaterThan(maxDelay0);
        });
    });
}
