// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Errors raised by `@parity/product-sdk-individuality`.
 *
 * Only one failure family exists here: the chain returned something the
 * descriptor says is impossible. Everything a caller can legitimately hit —
 * including a username nobody owns — travels on the success channel as a
 * `PersonhoodResult`, so catching an error from this package means the chain
 * and the committed metadata disagree.
 *
 * Catch with `instanceof ProductIndividualityError`, or across the whole SDK
 * family with `isSdkError(e)` from `@parity/product-sdk-errors`.
 */
import type { SdkError } from "@parity/product-sdk-errors";

/**
 * Base class for errors raised by `@parity/product-sdk-individuality`.
 *
 * Implements the cross-package {@link SdkError} marker so `isSdkError(e)` also
 * recognizes it.
 */
export class ProductIndividualityError extends Error implements SdkError {
    readonly isSdkError = true as const;
    readonly source = "individuality";

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ProductIndividualityError";
    }
}

/**
 * A raw storage value did not match the shape the descriptor promised — an
 * unknown `streak` or `recognition` variant, or a malformed grace ratio.
 *
 * **Messages must be fixed strings.** Never interpolate a decoded value into
 * one: the values here describe a person's chain state, and an error message
 * is the least controlled place they can end up. The variant that failed is
 * identifiable from the message text alone.
 */
export class IndividualityDecodeError extends ProductIndividualityError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "IndividualityDecodeError";
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    // Asserted structurally rather than through `isSdkError` from
    // `@parity/product-sdk-errors`: importing it would make this package's fast
    // test loop depend on that package being built first. `isSdkError` is
    // `e instanceof Error && e.isSdkError === true`, and its own suite covers
    // the predicate — so the two assertions below are the whole contract.
    describe("error hierarchy", () => {
        test("ProductIndividualityError carries the SdkError marker", () => {
            const err = new ProductIndividualityError("boom");
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("ProductIndividualityError");
            expect(err.isSdkError).toBe(true);
            expect(err.source).toBe("individuality");
        });

        test("IndividualityDecodeError extends the package base", () => {
            const err = new IndividualityDecodeError("unknown recognition variant");
            expect(err).toBeInstanceOf(ProductIndividualityError);
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("IndividualityDecodeError");
            expect(err.isSdkError).toBe(true);
            expect(err.source).toBe("individuality");
        });

        test("carries a cause when given one", () => {
            const cause = new Error("underlying");
            const err = new IndividualityDecodeError("malformed grace ratio", { cause });
            expect(err.cause).toBe(cause);
        });
    });
}
