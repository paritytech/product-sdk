// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A lightweight tagged `Result` type shared across the `@parity/product-sdk`
 * family.
 *
 * SDK functions that can fail return `Result<T, E>` (or `Promise<Result<T, E>>`)
 * rather than throwing, so consumers get typed errors on the `err` channel
 * instead of opaque thrown `Error`s. Layers compose with no adapter — a lower
 * package's `Result` flows straight into a higher one's pattern matching.
 *
 * This package is a zero-dependency leaf so it can be imported by every other
 * package (including those on the `signer → host` edge) without creating
 * dependency cycles.
 *
 * @module
 */

/** A value that is either a success (`ok`) carrying `T`, or a failure (`err`) carrying `E`. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Create a successful {@link Result}. */
export function ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<E>(error: E): Result<never, E> {
    return { ok: false, error };
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("ok", () => {
        test("produces an ok result with value", () => {
            const result = ok(42);
            expect(result.ok).toBe(true);
            expect(result).toEqual({ ok: true, value: 42 });
        });

        test("works with null value", () => {
            expect(ok(null)).toEqual({ ok: true, value: null });
        });
    });

    describe("err", () => {
        test("produces an error result", () => {
            const result = err("boom");
            expect(result.ok).toBe(false);
            expect(result).toEqual({ ok: false, error: "boom" });
        });
    });

    describe("narrowing", () => {
        test("the ok discriminant narrows value / error access", () => {
            const r: Result<number, string> = ok(1);
            if (r.ok) {
                // @ts-expect-error — `error` is not present on the ok branch
                void r.error;
                expect(r.value).toBe(1);
            }
        });
    });
}
