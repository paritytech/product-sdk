// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared plumbing for signers that write an origin-modifying transaction
 * extension.
 *
 * `withAsPerson` and `withLiteAlias` differ only in which extension they fill
 * and how its value is built. Everything else — patching a slot while keeping
 * the chain's declared order, reading the nonce back out of `CheckNonce`,
 * requesting a ring VRF proof defensively, caching the decoded pipeline — is
 * identical, and identical in ways that are easy to get subtly wrong, so it
 * lives here once. Internal to the package on purpose: these are
 * implementation details of the two signers, not a public contract.
 *
 * The errors are `AsPersonError` throughout. It is the write half's error
 * class, predates the second extension, and callers already catch it; a
 * parallel class per extension would split one failure domain in two.
 */
import type { PolkadotSigner } from "polkadot-api";

import {
    type ExtensionPipeline,
    decodeCheckNonce,
    encodeChecked,
    readExtensionPipeline,
} from "./as-person-codec.js";
import type { PapiSignedExtensions } from "./as-person-implication.js";
import { AsPersonError } from "./errors.js";

/** Metadata identifier of the extension that carries the host's signature. */
export const VERIFY_SIGNATURE = "VerifyMultiSignature";

/** Metadata identifier of the origin-restriction extension. */
export const RESTRICT_ORIGINS = "RestrictOrigins";

/** Metadata identifier of the nonce extension. */
export const CHECK_NONCE = "CheckNonce";

/**
 * A ring VRF proof and the values the chain needs to verify it.
 *
 * Structurally compatible with the host's `RingVRFProof`, and declared here
 * rather than imported so this package needs no dependency on
 * `@parity/product-sdk-host`. Same approach as `IndividualityChain`, and the
 * umbrella package asserts the two stay compatible at compile time.
 */
export interface RingVRFProof {
    /** Raw ring VRF proof bytes. */
    proof: Uint8Array;
    /** The alias the proof commits to, and the 32-byte context it is bound to. */
    contextualAlias: { context: Uint8Array; alias: Uint8Array };
    /** Index of the ring the proof was generated against. */
    ringIndex: number;
    /** Revision of that ring at generation time. */
    ringRevision: number;
}

/**
 * Produce a ring VRF proof over `message`.
 *
 * Wire this to `SignerManager.createRingVRFProof(keyHandle, context, location,
 * message)`, or to any other call that returns a proof for the context the chain
 * expects.
 *
 * **The message is computed by the wrapping signer and must not be chosen by
 * the caller.** It is blake2-256 of the call implication, which depends on the
 * nonce, the era, the tip and every other extension after the one being filled.
 * A proof over anything else fails on chain as a bad proof.
 *
 * The context is taken from the returned proof, not from the request, so
 * whichever call mints the proof decides it.
 */
export type CreateRingVRFProof = (message: Uint8Array) => Promise<RingVRFProof>;

/**
 * Set one slot's value, keeping the map in the order the chain declares.
 *
 * The order matters less than it looks: the host resolves V5 extension slots by
 * name. But a V4 body is a plain concatenation, where a reordered map shifts
 * every slot after the first difference, so the order is preserved rather than
 * relied upon not to matter.
 *
 * The implicit half is carried through untouched when the slot already exists,
 * and encoded from the chain's own declared type when it does not. That second
 * case is `VerifyMultiSignature`, which PAPI omits entirely whenever the host is
 * the one signing.
 */
export function withSlot(
    pipeline: ExtensionPipeline,
    extensions: PapiSignedExtensions,
    identifier: string,
    value: Uint8Array,
): PapiSignedExtensions {
    const slot = pipeline.slot(identifier);
    const existing = extensions[identifier];
    const additionalSigned =
        existing?.additionalSigned ??
        // Throws unless the declared implicit is empty, which is the only case
        // this package can fill on the chain's behalf.
        encodeChecked(pipeline.codec(slot.implicit), undefined);

    const next: PapiSignedExtensions = {
        ...extensions,
        [identifier]: { identifier, value, additionalSigned },
    };

    return Object.fromEntries(
        pipeline.extensions
            .filter((declared) => declared.identifier in next)
            .map((declared) => [declared.identifier, next[declared.identifier]]),
    ) as PapiSignedExtensions;
}

/** Read the account nonce out of the slot PAPI already filled. */
export function nonceFrom(pipeline: ExtensionPipeline, extensions: PapiSignedExtensions): number {
    const supplied = extensions[CHECK_NONCE];
    if (!supplied) {
        throw new AsPersonError(
            "signed extension CheckNonce is missing, so the account nonce cannot be read",
        );
    }
    return decodeCheckNonce(pipeline, supplied.value);
}

/**
 * Ask for a proof, and report both ways it can fail as this package's own error.
 *
 * `createProof` is the one input a caller has to write themselves, and it usually
 * adapts a host call that returns a `Result` into a promise of a plain object, so
 * resolving with `undefined` or a partial object is a likelier mistake than
 * rejecting. Without the shape check below that surfaces as
 * `TypeError: Cannot read properties of undefined`, which names neither this
 * package nor the callback.
 */
export async function requestProof(
    createProof: CreateRingVRFProof,
    message: Uint8Array,
): Promise<RingVRFProof> {
    let proof: RingVRFProof;
    try {
        proof = await createProof(message);
    } catch (cause) {
        // No message bytes and no proof bytes: both identify a person.
        throw new AsPersonError("ring VRF proof request failed", { cause });
    }

    if (
        !(proof?.proof instanceof Uint8Array) ||
        !(proof?.contextualAlias?.context instanceof Uint8Array) ||
        typeof proof?.ringIndex !== "number" ||
        typeof proof?.ringRevision !== "number"
    ) {
        // Which field is missing is not named: the values are pseudonymous
        // identity, and listing the present ones leaks by omission.
        throw new AsPersonError("ring VRF proof is missing a field the extension needs");
    }

    return proof;
}

/**
 * A per-signer pipeline reader that decodes each metadata blob once.
 *
 * Decoding the metadata is the expensive part of reading the pipeline, around
 * 7 ms for a 435 KB blob, and PAPI hands the same array for every signature
 * until the runtime upgrades. Cached on identity rather than content, so a
 * runtime upgrade brings a different array and cannot be served a stale
 * pipeline. One reader per wrapped signer, not module level, so two wrapped
 * signers on two chains cannot share an entry.
 */
export function cachedPipelineReader(): (metadata: Uint8Array) => ExtensionPipeline {
    let cached: { metadata: Uint8Array; pipeline: ExtensionPipeline } | undefined;
    return (metadata) => {
        if (cached?.metadata !== metadata) {
            cached = { metadata, pipeline: readExtensionPipeline(metadata) };
        }
        return cached.pipeline;
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");

    const METADATA = new Uint8Array(
        readFileSync(
            new URL("../../descriptors/.papi/metadata/paseo_individuality.scale", import.meta.url),
        ),
    );
    const PIPELINE = readExtensionPipeline(METADATA);

    /** Every declared slot except VerifyMultiSignature, as PAPI hands the map over. */
    function papiExtensions(): PapiSignedExtensions {
        return Object.fromEntries(
            PIPELINE.extensions
                .filter((slot) => slot.identifier !== VERIFY_SIGNATURE)
                .map((slot, index) => [
                    slot.identifier,
                    {
                        identifier: slot.identifier,
                        value: Uint8Array.from([index]),
                        additionalSigned: Uint8Array.from([100 + index]),
                    },
                ]),
        ) as PapiSignedExtensions;
    }

    describe("withSlot", () => {
        test("keeps the map in the order the chain declares", () => {
            // Filling the one slot PAPI omits must not append it at the end,
            // because a V4 body is a positional concatenation.
            const patched = withSlot(
                PIPELINE,
                papiExtensions(),
                VERIFY_SIGNATURE,
                Uint8Array.from([0x00]),
            );
            const declared = PIPELINE.extensions
                .map((slot) => slot.identifier)
                .filter((identifier) => identifier in patched);
            expect(Object.keys(patched)).toEqual(declared);
            expect(Object.keys(patched)[1]).toBe(VERIFY_SIGNATURE);
        });

        test("carries an existing slot's implicit through untouched", () => {
            const before = papiExtensions();
            const patched = withSlot(PIPELINE, before, RESTRICT_ORIGINS, Uint8Array.from([0x01]));
            expect(patched[RESTRICT_ORIGINS].additionalSigned).toBe(
                before[RESTRICT_ORIGINS].additionalSigned,
            );
            expect(patched[RESTRICT_ORIGINS].value).toEqual(Uint8Array.from([0x01]));
        });

        test("encodes an absent slot's implicit from the chain's declared type", () => {
            // VerifyMultiSignature's implicit is (), which encodes to nothing.
            const patched = withSlot(
                PIPELINE,
                papiExtensions(),
                VERIFY_SIGNATURE,
                Uint8Array.from([0x00]),
            );
            expect(patched[VERIFY_SIGNATURE].additionalSigned).toHaveLength(0);
        });
    });

    describe("nonceFrom", () => {
        test("reads back the compact nonce PAPI put in the body", () => {
            const nonceBytes = PIPELINE.codec(PIPELINE.slot(CHECK_NONCE).type)[0](300);
            const extensions = withSlot(PIPELINE, papiExtensions(), CHECK_NONCE, nonceBytes);
            expect(nonceFrom(PIPELINE, extensions)).toBe(300);
        });

        test("throws this package's error when the slot is missing", () => {
            const extensions = Object.fromEntries(
                Object.entries(papiExtensions()).filter(([key]) => key !== CHECK_NONCE),
            ) as PapiSignedExtensions;
            expect(() => nonceFrom(PIPELINE, extensions)).toThrow(AsPersonError);
        });
    });

    describe("cachedPipelineReader", () => {
        test("decodes a blob once and re-decodes on a new array", () => {
            const read = cachedPipelineReader();
            const first = read(METADATA);
            expect(read(METADATA)).toBe(first);
            // A different array means a different runtime, so the cache must miss.
            expect(read(new Uint8Array(METADATA))).not.toBe(first);
        });
    });
}
