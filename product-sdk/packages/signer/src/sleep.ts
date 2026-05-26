// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Sleep for a given duration, cancellable via AbortSignal.
 *
 * Resolves immediately if the signal is already aborted.
 * Cleans up the abort listener when the timer fires naturally
 * to prevent listener accumulation in retry loops.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }

        const onDone = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onDone);
            resolve();
        };

        const timer = setTimeout(onDone, ms);
        signal?.addEventListener("abort", onDone, { once: true });
    });
}

if (import.meta.vitest) {
    const { test, expect, describe, vi, beforeEach, afterEach } = import.meta.vitest;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("sleep", () => {
        test("resolves after specified duration", async () => {
            let resolved = false;
            sleep(100).then(() => {
                resolved = true;
            });

            expect(resolved).toBe(false);
            await vi.advanceTimersByTimeAsync(99);
            expect(resolved).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(resolved).toBe(true);
        });

        test("resolves immediately when signal is already aborted", async () => {
            const controller = new AbortController();
            controller.abort();

            let resolved = false;
            sleep(10_000, controller.signal).then(() => {
                resolved = true;
            });

            // Should resolve on next microtask, not after 10s
            await vi.advanceTimersByTimeAsync(0);
            expect(resolved).toBe(true);
        });

        test("resolves early when signal is aborted during sleep", async () => {
            const controller = new AbortController();
            let resolved = false;
            sleep(10_000, controller.signal).then(() => {
                resolved = true;
            });

            await vi.advanceTimersByTimeAsync(50);
            expect(resolved).toBe(false);

            controller.abort();
            await vi.advanceTimersByTimeAsync(0);
            expect(resolved).toBe(true);
        });

        test("works without a signal", async () => {
            let resolved = false;
            sleep(50).then(() => {
                resolved = true;
            });

            await vi.advanceTimersByTimeAsync(50);
            expect(resolved).toBe(true);
        });

        test("cleans up abort listener after natural timer expiry", async () => {
            const controller = new AbortController();
            const addSpy = vi.spyOn(controller.signal, "addEventListener");
            const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

            sleep(50, controller.signal);
            expect(addSpy).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(50);
            expect(removeSpy).toHaveBeenCalledTimes(1);
        });
    });
}
