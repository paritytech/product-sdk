// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wall clock and timers, injected so that tests control time.
 *
 * Code that retries, debounces or schedules takes a `Clock` instead of calling
 * `Date.now()` and `setTimeout` itself; tests pass a `ManualClock` from
 * `@parity/product-sdk-utils/testing` and advance it.
 */
export interface Clock {
    /** Milliseconds since the Unix epoch. */
    nowMs(): number;
    /** Resolves after `ms` milliseconds. */
    sleep(ms: number): Promise<void>;
}

/** The system clock: `Date.now()` and `setTimeout`. */
export const systemClock: Clock = {
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A source of unique identifiers, injected so that tests get predictable ones. */
export interface IdSource {
    next(): string;
}

/**
 * Random lowercase UUID v4 strings, the identifiers the native chat apps give
 * messages and requests.
 */
export const uuidSource: IdSource = {
    next() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
};

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("uuidSource gives distinct version 4 UUIDs", () => {
        const first = uuidSource.next();
        expect(first).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(uuidSource.next()).not.toBe(first);
    });

    test("systemClock sleeps and reads the time", async () => {
        const before = systemClock.nowMs();
        await systemClock.sleep(1);
        expect(systemClock.nowMs()).toBeGreaterThanOrEqual(before);
    });
}
