// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Waiting and retrying for funding sessions. Every wait honours an
 * `AbortSignal`, so a cancelled session or a stopped server unwinds at once.
 *
 * @module
 */
import { FundingAbortedError, isTransient as defaultIsTransient } from "./errors.js";

/** Resolve after `ms`, or reject with {@link FundingAbortedError} when `signal` fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new FundingAbortedError("sleep"));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new FundingAbortedError("sleep"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Resolve at Unix ms `at`, at once if it has passed. Save the time you wait
 * for before you start waiting, so a restarted worker waits only the rest.
 */
export function waitUntil(at: number, signal?: AbortSignal): Promise<void> {
    return sleep(Math.max(0, at - Date.now()), signal);
}

/** Options for {@link retry}. */
export interface RetryOptions {
    /** Tries in all, the first included. Default 8. */
    attempts?: number;
    /** Wait before the second try, doubling after each. Default 1 s. */
    delayMs?: number;
    /** Longest wait between tries. Default 30 s. */
    maxDelayMs?: number;
    signal?: AbortSignal;
    /** Which errors to retry. Default: the funding module's `isTransient`. */
    isTransient?: (error: unknown) => boolean;
}

/**
 * Run `fn`, retrying transient failures with a doubling wait. A failure that
 * is not transient, or the last one, is thrown as it is.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const attempts = options.attempts ?? 8;
    const maxDelay = options.maxDelayMs ?? 30_000;
    const transient = options.isTransient ?? defaultIsTransient;
    let delay = options.delayMs ?? 1_000;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt >= attempts || !transient(error)) throw error;
        }
        await sleep(delay, options.signal);
        delay = Math.min(delay * 2, maxDelay);
    }
}

/**
 * Read `read` every `everyMs` until it yields a value, or until Unix ms
 * `until` passes (then throws). Transient read failures count as no value yet.
 */
export async function poll<T>(
    read: () => Promise<T | undefined>,
    options: { everyMs?: number; until?: number; signal?: AbortSignal } = {},
): Promise<T> {
    const every = options.everyMs ?? 6_000;
    for (;;) {
        try {
            const value = await read();
            if (value !== undefined) return value;
        } catch (error) {
            if (!defaultIsTransient(error)) throw error;
        }
        if (options.until !== undefined && Date.now() >= options.until) {
            throw new Error("poll timed out");
        }
        await sleep(every, options.signal);
    }
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("retry", () => {
        test("retries transient failures until one succeeds", async () => {
            let calls = 0;
            const value = await retry(
                async () => {
                    calls += 1;
                    if (calls < 3) throw new Error("flaky");
                    return "done";
                },
                { delayMs: 1 },
            );
            expect(value).toBe("done");
            expect(calls).toBe(3);
        });

        test("throws a failure that is not transient at once", async () => {
            let calls = 0;
            await expect(
                retry(
                    async () => {
                        calls += 1;
                        throw new TypeError("bug");
                    },
                    { delayMs: 1 },
                ),
            ).rejects.toThrow(TypeError);
            expect(calls).toBe(1);
        });

        test("gives up after its attempts", async () => {
            await expect(
                retry(
                    async () => {
                        throw new Error("down");
                    },
                    { attempts: 2, delayMs: 1 },
                ),
            ).rejects.toThrow("down");
        });
    });

    test("sleep rejects when its signal fires", async () => {
        const controller = new AbortController();
        const slept = sleep(10_000, controller.signal);
        controller.abort();
        await expect(slept).rejects.toBeInstanceOf(FundingAbortedError);
    });

    test("poll reads until there is a value", async () => {
        let n = 0;
        expect(await poll(async () => (++n === 3 ? n : undefined), { everyMs: 1 })).toBe(3);
    });
}
