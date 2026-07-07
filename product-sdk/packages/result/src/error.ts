// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A cross-package marker for errors that originate in the `@parity/product-sdk`
 * family.
 *
 * Each package keeps its own error hierarchy and base class (`HostError`,
 * `SignerError`, `ContractError`, …). This module does NOT unify them under one
 * class — it provides a structural {@link SdkError} marker that every base error
 * implements, so a consumer can identify any SDK-origin error with a single
 * {@link isSdkError} check, without importing per-package classes or coupling
 * hierarchies.
 *
 * @module
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

/** Check whether a value is any {@link SdkError} (i.e. any `@parity/product-sdk` error). */
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
