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

/**
 * Assert a {@link Result} is `ok` and return its value, throwing otherwise.
 *
 * Intended for tests and scripts where an `err` is a hard failure — the throw
 * surfaces a clear message (and the wrong-channel error) instead of a confusing
 * downstream `undefined`. Framework-agnostic: it throws a plain `Error`, so it
 * fails any test runner without depending on one.
 */
export function unwrapOk<T>(result: Result<T, unknown>): T {
    if (!result.ok) {
        throw new Error(`unwrapOk: expected ok, got err: ${formatChannel(result.error)}`);
    }
    return result.value;
}

/** Assert a {@link Result} is `err` and return its error, throwing otherwise. */
export function unwrapErr<E>(result: Result<unknown, E>): E {
    if (result.ok) {
        throw new Error(`unwrapErr: expected err, got ok: ${formatChannel(result.value)}`);
    }
    return result.error;
}

/** Best-effort one-line rendering of a Result channel for unwrap error messages. */
function formatChannel(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
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

    describe("unwrapOk", () => {
        test("returns the value of an ok result", () => {
            expect(unwrapOk(ok(42))).toBe(42);
        });

        test("throws on an err result, including the error in the message", () => {
            expect(() => unwrapOk(err("boom"))).toThrow(/expected ok.*boom/);
        });

        test("renders an Error err channel via its message", () => {
            expect(() => unwrapOk(err(new Error("kaboom")))).toThrow(/kaboom/);
        });
    });

    describe("unwrapErr", () => {
        test("returns the error of an err result", () => {
            expect(unwrapErr(err("nope"))).toBe("nope");
        });

        test("throws on an ok result", () => {
            expect(() => unwrapErr(ok(1))).toThrow(/expected err/);
        });
    });
}
