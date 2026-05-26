// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Result-based retry with exponential backoff for signer connection attempts.
 *
 * This retry utility works with `Result<T, E>` return values (not exceptions).
 * It exists separately from the tx package's exception-based `withRetry` because:
 *
 * - **Signer retry**: retries connection attempts that return `Result<T, SignerError>`.
 *   Errors are expected values, not exceptional conditions. Supports AbortSignal.
 * - **TX retry**: retries transaction submissions that throw exceptions.
 *   Non-retryable errors (dispatch, rejection, timeout) are detected and rethrown.
 *
 * Both use exponential backoff but serve different abstraction layers.
 *
 * @module
 */
import { sleep } from "./sleep.js";
import type { Result } from "./types.js";

/** Options for retry with exponential backoff. */
export interface RetryOptions {
    /** Maximum number of attempts. Default: 3 */
    maxAttempts?: number;
    /** Initial delay in ms before first retry. Default: 500 */
    initialDelay?: number;
    /** Multiplier applied to delay after each attempt. Default: 2 */
    backoffMultiplier?: number;
    /** Maximum delay cap in ms. Default: 10_000 */
    maxDelay?: number;
    /** AbortSignal to cancel retries early. */
    signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY = 500;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_DELAY = 10_000;

/**
 * Retry an async operation with exponential backoff.
 *
 * Calls `fn` up to `maxAttempts` times. If `fn` returns an error result,
 * waits with exponential backoff before the next attempt. Returns the first
 * successful result or the last error.
 */
export async function withRetry<T, E>(
    fn: (attempt: number) => Promise<Result<T, E>>,
    options?: RetryOptions,
): Promise<Result<T, E>> {
    const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const initialDelay = options?.initialDelay ?? DEFAULT_INITIAL_DELAY;
    const backoffMultiplier = options?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    const maxDelay = options?.maxDelay ?? DEFAULT_MAX_DELAY;
    const signal = options?.signal;

    let lastResult: Result<T, E> | undefined;
    let delay = initialDelay;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted && lastResult) {
            return lastResult;
        }

        lastResult = await fn(attempt);
        if (lastResult.ok) {
            return lastResult;
        }

        // Don't delay after the last attempt
        if (attempt < maxAttempts - 1) {
            await sleep(delay, signal);
            delay = Math.min(delay * backoffMultiplier, maxDelay);
        }
    }

    // lastResult is always defined here since maxAttempts >= 1
    return lastResult!;
}

if (import.meta.vitest) {
    const { test, expect, describe, vi, beforeEach, afterEach } = import.meta.vitest;
    const { ok, err } = await import("./types.js");

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("withRetry", () => {
        test("succeeds on first attempt with no delay", async () => {
            const fn = vi.fn().mockResolvedValue(ok("done"));
            const promise = withRetry(fn);
            const result = await promise;
            expect(result).toEqual(ok("done"));
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn).toHaveBeenCalledWith(0);
        });

        test("retries on failure and succeeds on second attempt", async () => {
            const fn = vi
                .fn()
                .mockResolvedValueOnce(err("fail1"))
                .mockResolvedValueOnce(ok("success"));

            const promise = withRetry(fn, { initialDelay: 100 });
            await vi.advanceTimersByTimeAsync(100);
            const result = await promise;

            expect(result).toEqual(ok("success"));
            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenNthCalledWith(1, 0);
            expect(fn).toHaveBeenNthCalledWith(2, 1);
        });

        test("exhausts maxAttempts and returns last error", async () => {
            const fn = vi
                .fn()
                .mockResolvedValueOnce(err("fail1"))
                .mockResolvedValueOnce(err("fail2"))
                .mockResolvedValueOnce(err("fail3"));

            const promise = withRetry(fn, {
                maxAttempts: 3,
                initialDelay: 100,
                backoffMultiplier: 2,
            });

            await vi.advanceTimersByTimeAsync(100); // delay after attempt 0
            await vi.advanceTimersByTimeAsync(200); // delay after attempt 1
            const result = await promise;

            expect(result).toEqual(err("fail3"));
            expect(fn).toHaveBeenCalledTimes(3);
        });

        test("respects AbortSignal cancellation", async () => {
            const controller = new AbortController();
            const fn = vi.fn().mockResolvedValue(err("fail"));

            const promise = withRetry(fn, {
                maxAttempts: 5,
                initialDelay: 1000,
                signal: controller.signal,
            });

            // First attempt runs, then abort during delay
            await vi.advanceTimersByTimeAsync(0);
            controller.abort();
            await vi.advanceTimersByTimeAsync(0);
            const result = await promise;

            expect(result.ok).toBe(false);
            // Should not have retried all 5 times
            expect(fn.mock.calls.length).toBeLessThan(5);
        });

        test("backoff delay increases correctly", async () => {
            const fn = vi
                .fn()
                .mockResolvedValueOnce(err("e1"))
                .mockResolvedValueOnce(err("e2"))
                .mockResolvedValueOnce(err("e3"))
                .mockResolvedValueOnce(ok("done"));

            const promise = withRetry(fn, {
                maxAttempts: 4,
                initialDelay: 100,
                backoffMultiplier: 2,
            });

            // After attempt 0: delay 100ms
            await vi.advanceTimersByTimeAsync(100);
            // After attempt 1: delay 200ms
            await vi.advanceTimersByTimeAsync(200);
            // After attempt 2: delay 400ms
            await vi.advanceTimersByTimeAsync(400);
            const result = await promise;

            expect(result).toEqual(ok("done"));
            expect(fn).toHaveBeenCalledTimes(4);
        });

        test("caps delay at maxDelay", async () => {
            const fn = vi.fn().mockImplementation(async () => {
                return err("fail");
            });

            const promise = withRetry(fn, {
                maxAttempts: 4,
                initialDelay: 5000,
                backoffMultiplier: 3,
                maxDelay: 8000,
            });

            // Attempt 0, delay 5000ms
            await vi.advanceTimersByTimeAsync(5000);
            // Attempt 1, delay min(15000, 8000) = 8000ms
            await vi.advanceTimersByTimeAsync(8000);
            // Attempt 2, delay min(24000, 8000) = 8000ms
            await vi.advanceTimersByTimeAsync(8000);
            const result = await promise;

            expect(result.ok).toBe(false);
            expect(fn).toHaveBeenCalledTimes(4);
        });

        test("attempt number is passed correctly to fn", async () => {
            const attempts: number[] = [];
            const fn = vi.fn().mockImplementation(async (attempt: number) => {
                attempts.push(attempt);
                return attempt < 2 ? err("retry") : ok("done");
            });

            const promise = withRetry(fn, {
                maxAttempts: 3,
                initialDelay: 50,
            });
            await vi.advanceTimersByTimeAsync(50);
            await vi.advanceTimersByTimeAsync(100);
            await promise;

            expect(attempts).toEqual([0, 1, 2]);
        });

        test("single attempt with maxAttempts=1", async () => {
            const fn = vi.fn().mockResolvedValue(err("fail"));

            const result = await withRetry(fn, { maxAttempts: 1 });
            expect(result).toEqual(err("fail"));
            expect(fn).toHaveBeenCalledTimes(1);
        });

        test("signal already aborted before first attempt — fn still called once", async () => {
            const controller = new AbortController();
            controller.abort();

            const fn = vi.fn().mockResolvedValue(err("fail"));
            const result = await withRetry(fn, {
                maxAttempts: 3,
                signal: controller.signal,
            });

            expect(result.ok).toBe(false);
            // fn is called once so it can produce a properly-typed error
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });
}
