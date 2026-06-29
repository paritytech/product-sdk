// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A lightweight tagged `Result` type for the host public API.
 *
 * Host functions return `Promise<Result<T, HostError>>` rather than throwing, so
 * consumers get typed errors on the `err` channel instead of opaque thrown
 * `Error`s. The shape is intentionally identical to the one
 * `@parity/product-sdk-signer` exposes (`{ ok: true; value } | { ok: false; error }`),
 * so the two layers compose with no adapter — host's `Result` flows straight into
 * the signer's pattern matching.
 *
 * NOTE: host owns its own copy because the dependency edge runs `signer → host`,
 * so host cannot import the signer's definition. If a third package ever needs
 * this shape, extract it into a shared `@parity/product-sdk-result` package and
 * have both depend on that instead of duplicating.
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
}
