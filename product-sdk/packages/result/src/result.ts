// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A lightweight tagged `Result` type.
 *
 * Functions that can fail return `Result<T, E>` (or `Promise<Result<T, E>>`)
 * rather than throwing, so callers get typed errors on the `err` channel instead
 * of opaque thrown `Error`s. Layers compose with no adapter — a lower layer's
 * `Result` flows straight into a higher one's pattern matching.
 *
 * Zero dependencies and domain-agnostic, so it can be imported anywhere without
 * cycles.
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

/**
 * Constructor of an `Error` subclass that accepts the standard
 * `(message, options?)` shape — the contract an error class must satisfy to be
 * used as the target for {@link normalizeError}.
 */
export type ErrorClass<E extends Error> = new (message: string, options?: { cause?: unknown }) => E;

/**
 * Coerce an unknown thrown value into a specific error class, for putting on the
 * `err` channel of a {@link Result}.
 *
 * Use this instead of an unchecked `error as SomeError` cast (which lies to the
 * type system when the thrown value isn't actually that class). If `cause` is
 * already an instance of `ErrorCtor` it's returned unchanged; otherwise it's
 * wrapped in a new `ErrorCtor` whose message is `cause`'s message (or its
 * stringification) and whose `cause` is the original value.
 *
 * @example
 * try { risky(); } catch (e) { return err(normalizeError(e, MyError)); }
 */
export function normalizeError<E extends Error>(cause: unknown, ErrorCtor: ErrorClass<E>): E {
    if (cause instanceof ErrorCtor) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new ErrorCtor(message, { cause });
}

/**
 * Type-narrowing guard for "is this value an instance of `ErrorCtor`?".
 *
 * A thin, typed wrapper over `instanceof` — useful for narrowing a {@link Result}'s
 * `err` channel (`if (isErrorOf(r.error, SomeError))`) without a manual cast.
 * Accepts any error class.
 */
export function isErrorOf<E extends Error>(
    error: unknown,
    ErrorCtor: abstract new (...args: never[]) => E,
): error is E {
    return error instanceof ErrorCtor;
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

    describe("normalizeError", () => {
        class MyError extends Error {
            constructor(message: string, options?: { cause?: unknown }) {
                super(message, options);
                this.name = "MyError";
            }
        }

        test("returns the value unchanged when already the target class", () => {
            const original = new MyError("boom");
            expect(normalizeError(original, MyError)).toBe(original);
        });

        test("wraps a foreign Error, preserving message and cause", () => {
            const raw = new Error("network down");
            const normalized = normalizeError(raw, MyError);
            expect(normalized).toBeInstanceOf(MyError);
            expect(normalized.message).toBe("network down");
            expect(normalized.cause).toBe(raw);
        });

        test("wraps a non-Error thrown value by stringifying it", () => {
            const normalized = normalizeError("just a string", MyError);
            expect(normalized).toBeInstanceOf(MyError);
            expect(normalized.message).toBe("just a string");
            expect(normalized.cause).toBe("just a string");
        });

        test("a subclass instance passes through (it is an instanceof the base)", () => {
            class MySubError extends MyError {}
            const sub = new MySubError("sub");
            expect(normalizeError(sub, MyError)).toBe(sub);
        });
    });

    describe("isErrorOf", () => {
        class FooError extends Error {}
        class BarError extends Error {}

        test("recognizes an instance of the given class", () => {
            expect(isErrorOf(new FooError("x"), FooError)).toBe(true);
        });

        test("rejects a different class or a plain Error", () => {
            expect(isErrorOf(new BarError("x"), FooError)).toBe(false);
            expect(isErrorOf(new Error("plain"), FooError)).toBe(false);
        });

        test("rejects non-error values", () => {
            expect(isErrorOf("string", FooError)).toBe(false);
            expect(isErrorOf(null, FooError)).toBe(false);
        });

        test("matches subclasses (instanceof semantics)", () => {
            class SubFoo extends FooError {}
            expect(isErrorOf(new SubFoo("s"), FooError)).toBe(true);
        });
    });
}
