// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Errors raised by `@parity/product-sdk-nfts`.
 *
 * Every read returns a `Result`, so these arrive on the `err` channel rather
 * than as throws: an unreachable node, an aborted signal, or the pinned block
 * leaving the follower's window mid-read, each normalized into
 * {@link ProductNftsError} with the original cause attached.
 *
 * A collection that does not exist is **not** an error. `getCollectionItems`
 * answers `ok({ tag: "NotFound", ... })`, because the chain was asked and
 * answered.
 *
 * {@link NftsChainEntryError} is the one worth recognising by class. It means the
 * client cannot read an entry this package needs, which is a wiring fault in the
 * app rather than anything the chain did, and no retry will clear it.
 *
 * Narrow with `isErrorOf(e, NftsDecodeError)` from `@parity/result`, or
 * recognise any SDK error with `isSdkError(e)` from
 * `@parity/product-sdk-errors`.
 */
import type { SdkError } from "@parity/product-sdk-errors";

/**
 * Base class for errors raised by `@parity/product-sdk-nfts`.
 *
 * Implements the cross-package {@link SdkError} marker so `isSdkError(e)` also
 * recognizes it.
 */
export class ProductNftsError extends Error implements SdkError {
    readonly isSdkError = true as const;
    readonly source = "nfts";

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ProductNftsError";
    }
}

/**
 * A raw storage value did not match the shape the descriptor promised — an
 * `ItemSelection` variant this package does not know, or a metadata entry whose
 * value is neither raw bytes nor a `Binary` wrapper.
 *
 * **Messages must be fixed strings.** Never interpolate a decoded value into
 * one: item metadata is author-supplied content, and an error message is the
 * least controlled place it can end up. The entry that failed is identifiable
 * from the message text alone.
 */
export class NftsDecodeError extends ProductNftsError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "NftsDecodeError";
    }
}

/**
 * A storage entry a read needs cannot be read on the client it was given.
 *
 * Either the descriptors do not carry the entry or the runtime does not, and the
 * message says which. Carries the entry as a field for programmatic handling,
 * the same shape as `GenesisMismatchError` in
 * `@parity/product-sdk-chain-client`.
 *
 * Naming the entry in the message is deliberate and does not contradict the rule
 * on {@link NftsDecodeError}: the entry is a pallet and storage name PAPI
 * reported, not chain content an author supplied.
 */
export class NftsChainEntryError extends ProductNftsError {
    /** The `Pallet.Entry` PAPI named, or `null` when its message did not. */
    readonly entry: string | null;

    constructor(message: string, entry: string | null, options?: ErrorOptions) {
        super(message, options);
        this.name = "NftsChainEntryError";
        this.entry = entry;
    }
}

/** `Storage(Scarcity.ItemDefs)` — the one part of PAPI's message worth keeping. */
function entryFrom(message: string): string | null {
    return /Storage\(([^)]+)\)/.exec(message)?.[1] ?? null;
}

function subject(entry: string | null): string {
    return entry === null ? "A storage entry this read needs" : `Storage entry ${entry}`;
}

/** The descriptors are missing the entry, or its shape no longer matches. */
function descriptorMissing(entry: string | null): string {
    return `${subject(entry)} is absent from the chain descriptors, or its shape drifted from the runtime. An app that prunes its own descriptors must whitelist every entry this package reads.`;
}

/** The runtime itself has no such entry, so no descriptor could carry it. */
function runtimeMissing(entry: string | null): string {
    return `${subject(entry)} does not exist in the runtime. This chain carries neither the Scarcity nor the NftClaims pallet.`;
}

/**
 * PAPI's two "entry not usable here" errors onto {@link NftsChainEntryError}.
 *
 * Matched on message text, because PAPI raises a bare `Error` for both and
 * neither carries a code — the same best-effort shape as `isSigningRejection` in
 * `@parity/product-sdk-tx`. An unrecognised message returns `null` so the caller
 * falls back to the generic normalization, which is also what happens if PAPI
 * ever rewords these.
 */
export function matchChainEntryError(cause: unknown): NftsChainEntryError | null {
    if (!(cause instanceof Error)) return null;
    if (cause.message.startsWith("Incompatible runtime entry Storage(")) {
        const entry = entryFrom(cause.message);
        return new NftsChainEntryError(descriptorMissing(entry), entry, { cause });
    }
    if (cause.message.startsWith("Runtime entry Storage(") && cause.message.endsWith("not found")) {
        const entry = entryFrom(cause.message);
        return new NftsChainEntryError(runtimeMissing(entry), entry, { cause });
    }
    return null;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    // Asserted structurally rather than through `isSdkError` from
    // `@parity/product-sdk-errors`: importing it would make this package's fast
    // test loop depend on that package being built first.
    describe("error hierarchy", () => {
        test("ProductNftsError carries the SdkError marker", () => {
            const error = new ProductNftsError("boom");
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe("ProductNftsError");
            expect(error.isSdkError).toBe(true);
            expect(error.source).toBe("nfts");
        });

        test("NftsDecodeError extends the package base", () => {
            const error = new NftsDecodeError("unknown ItemSelection variant");
            expect(error).toBeInstanceOf(ProductNftsError);
            expect(error.name).toBe("NftsDecodeError");
            expect(error.source).toBe("nfts");
        });

        test("carries a cause when given one", () => {
            const cause = new Error("underlying");
            expect(new NftsDecodeError("boom", { cause }).cause).toBe(cause);
        });
    });

    describe("matchChainEntryError", () => {
        // The two messages PAPI raises, verbatim from
        // `polkadot-api/dist/src/storage.js`.
        const incompatible = () =>
            new Error("Incompatible runtime entry Storage(Scarcity.CollectionMetadata)");
        const notFound = () => new Error("Runtime entry Storage(Scarcity.ItemDefs) not found");

        test("a pruned or drifted descriptor is recognised", () => {
            const cause = incompatible();
            const error = matchChainEntryError(cause);
            expect(error).toBeInstanceOf(NftsChainEntryError);
            expect(error?.cause).toBe(cause);
            expect(error?.entry).toBe("Scarcity.CollectionMetadata");
            expect(error?.message).toContain("Scarcity.CollectionMetadata");
        });

        test("a runtime without the entry is recognised", () => {
            const cause = notFound();
            const error = matchChainEntryError(cause);
            expect(error).toBeInstanceOf(NftsChainEntryError);
            expect(error?.cause).toBe(cause);
            expect(error?.entry).toBe("Scarcity.ItemDefs");
        });

        test("the two causes do not report the same message", () => {
            expect(matchChainEntryError(incompatible())?.message).not.toBe(
                matchChainEntryError(notFound())?.message,
            );
        });

        test("a message PAPI reworded past the entry still reports", () => {
            // The entry is the only part parsed out, so losing it must not lose
            // the classification.
            const error = matchChainEntryError(new Error("Incompatible runtime entry Storage("));
            expect(error).toBeInstanceOf(NftsChainEntryError);
            expect(error?.entry).toBeNull();
            expect(error?.message).toContain("A storage entry this read needs");
        });

        test("an unrelated error is left alone", () => {
            expect(matchChainEntryError(new Error("node unreachable"))).toBeNull();
        });

        test("a non-Error is left alone", () => {
            expect(
                matchChainEntryError("Incompatible runtime entry Storage(Scarcity.ItemDefs)"),
            ).toBeNull();
        });
    });
}
