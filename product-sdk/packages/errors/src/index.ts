// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-errors — the cross-package `SdkError` marker for the
 * `@parity/product-sdk` family.
 *
 * This is intentionally separate from the generic `@parity/result` package:
 * `@parity/result` is a domain-agnostic `Result` primitive (safe to embed
 * anywhere, including upstream in `@parity/truapi`), whereas the `SdkError`
 * marker below is specific to the `@parity/product-sdk` error taxonomy.
 *
 * @packageDocumentation
 */

/**
 * Structural marker implemented by every `@parity/product-sdk-*` base error.
 *
 * Intentionally an interface, not a class: a package implements it by declaring
 * `isSdkError` and `source` on its existing base error, which needs no runtime
 * dependency on this package (only the type) — so it works even across the
 * `signer → host` dependency edge.
 */
export interface SdkError extends Error {
    /** Discriminant present on all SDK errors. */
    readonly isSdkError: true;
    /** The package that raised the error, e.g. `"host"`, `"signer"`, `"contracts"`. */
    readonly source: string;
}

/**
 * Check whether a value is any {@link SdkError} — i.e. any error raised by an
 * `@parity/product-sdk-*` package.
 *
 * Answers the cross-cutting "did the SDK raise this?" question in one call,
 * without importing per-package error classes. For a *specific* class, use
 * `isErrorOf(e, SomeError)` from `@parity/result` instead.
 */
export function isSdkError(error: unknown): error is SdkError {
    return error instanceof Error && (error as Partial<SdkError>).isSdkError === true;
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    // A stand-in base error, mirroring how a real package implements the marker.
    class SampleError extends Error implements SdkError {
        readonly isSdkError = true as const;
        readonly source = "sample";
        constructor(message: string) {
            super(message);
            this.name = "SampleError";
        }
    }

    describe("isSdkError", () => {
        test("recognizes an error implementing the marker", () => {
            const e = new SampleError("boom");
            expect(isSdkError(e)).toBe(true);
            expect(e.source).toBe("sample");
        });

        test("rejects a plain Error", () => {
            expect(isSdkError(new Error("plain"))).toBe(false);
        });

        test("rejects non-error values", () => {
            expect(isSdkError("string")).toBe(false);
            expect(isSdkError(null)).toBe(false);
            expect(isSdkError({ isSdkError: true })).toBe(false); // not an Error instance
        });

        test("narrows to SdkError", () => {
            const e: unknown = new SampleError("x");
            if (isSdkError(e)) {
                expect(e.source).toBe("sample");
            }
        });
    });
}
