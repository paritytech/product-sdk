// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test helpers for code that takes a {@link Clock}.
 *
 * @module
 */
import type { Clock } from "./time.js";

/**
 * Lets queued microtasks and promise continuations run, then one macrotask.
 *
 * @param rounds - How many microtask turns to yield before the macrotask.
 */
export async function settle(rounds = 20): Promise<void> {
    for (let round = 0; round < rounds; round++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A clock that moves only when the test advances it. `sleep` resolves once
 * {@link ManualClock.advance} moves time past its deadline, so retry, debounce
 * and renewal logic runs without real waiting.
 *
 * @example
 * ```ts
 * import { ManualClock } from "@parity/product-sdk-utils/testing";
 *
 * const clock = new ManualClock();
 * const done = clock.sleep(1_000);
 * await clock.advance(1_000); // `done` has resolved
 * ```
 */
export class ManualClock implements Clock {
    private now: number;
    private readonly sleepers: { at: number; resolve: () => void }[] = [];

    /** @param startMs - The time the clock starts at. Default 2026-10-20T00:00:00Z. */
    constructor(startMs = Date.UTC(2026, 9, 20)) {
        this.now = startMs;
    }

    nowMs(): number {
        return this.now;
    }

    sleep(ms: number): Promise<void> {
        return new Promise((resolve) => this.sleepers.push({ at: this.now + ms, resolve }));
    }

    /** Moves time forward and wakes due sleepers in order, letting promise chains settle between wakes. */
    async advance(ms: number): Promise<void> {
        const target = this.now + ms;
        for (;;) {
            this.sleepers.sort((left, right) => left.at - right.at);
            const next = this.sleepers[0];
            if (!next || next.at > target) break;
            this.sleepers.shift();
            this.now = Math.max(this.now, next.at);
            next.resolve();
            await settle();
        }
        this.now = target;
        await settle();
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("sleepers wake in deadline order as time advances", async () => {
        const clock = new ManualClock(0);
        const woke: number[] = [];
        void clock.sleep(30).then(() => woke.push(30));
        void clock.sleep(10).then(() => woke.push(10));
        await clock.advance(20);
        expect(woke).toEqual([10]);
        expect(clock.nowMs()).toBe(20);
        await clock.advance(10);
        expect(woke).toEqual([10, 30]);
    });

    test("a sleep started by a woken sleeper wakes in the same advance", async () => {
        const clock = new ManualClock(0);
        let rounds = 0;
        void clock.sleep(5).then(() => {
            rounds++;
            return clock.sleep(5).then(() => rounds++);
        });
        await clock.advance(10);
        expect(rounds).toBe(2);
    });
}
