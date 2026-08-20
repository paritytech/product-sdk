// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Errors raised by `@parity/product-sdk-individuality`.
 *
 * `readPersonhoodState` returns a `Result`, so these arrive on the `err`
 * channel rather than as throws. Two kinds reach it:
 *
 * - {@link IndividualityDecodeError}, when the chain returns a shape the
 *   descriptor says is impossible.
 * - {@link ProductIndividualityError} itself, carrying any other failure as its
 *   `cause`: an unreachable node, an aborted signal, or the pinned block leaving
 *   the follower's window mid-read.
 *
 * A username nobody owns is neither. It is a successful answer and travels on
 * the `ok` channel as a `PersonhoodResult`.
 *
 * Narrow with `isErrorOf(e, IndividualityDecodeError)` from `@parity/result`, or
 * recognise any SDK error with `isSdkError(e)` from
 * `@parity/product-sdk-errors`.
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

/**
 * Building the `AsPerson` transaction extension failed.
 *
 * Raised when the chain does not declare the extension, declares a pipeline
 * version this package cannot encode, or when a value does not survive a round
 * trip through the chain's own codec.
 *
 * Unlike {@link IndividualityDecodeError} this one is thrown, not returned: it
 * happens inside `PolkadotSigner.signTx`, where the only channel available is
 * the exception PAPI already surfaces on the transaction's error path.
 *
 * **Never interpolate a proof, a context or an alias into the message.** Those
 * are pseudonymous identity, and an error string is the least controlled place
 * they can end up. An extension identifier or a version number is fine.
 */
export class AsPersonError extends ProductIndividualityError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "AsPersonError";
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
