// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared plumbing for signers that write an origin-modifying transaction
 * extension.
 *
 * `withAsPerson`, `withLiteAlias` and `withScoreParticipant` differ only in
 * which extension they fill and how its value is built. Everything else —
 * patching a slot while keeping the chain's declared order, reading the nonce
 * back out of `CheckNonce`, requesting a ring VRF proof defensively, caching
 * the decoded pipeline — is identical, and identical in ways that are easy to
 * get subtly wrong, so it lives here once. Internal to the package on purpose:
 * these are implementation details of the three signers, not a public contract.
 *
 * The errors are `AsPersonError` throughout. It is the write half's error
 * class, predates the second extension, and callers already catch it; a
 * parallel class per extension would split one failure domain in two.
 */
import type { PolkadotSigner } from "polkadot-api";

import {
    type ExtensionPipeline,
    type TypeCodec,
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

/** Restricted origins are metered against an allowance; `false` rejects them outright. */
export const RESTRICT_ORIGINS_ENABLED = true;

/** `Disabled`: no signature slot, so the origin stays `None`. */
export const VERIFY_SIGNATURE_DISABLED = { type: "Disabled", value: undefined };

/**
 * The extensions a fee estimate passes to PAPI. PAPI cannot fill
 * `VerifyMultiSignature`, which the host fills with the account signature when it
 * signs, so the estimate signs the extrinsic the classic way with the extension
 * `Disabled`. The length differs by a few bytes at most.
 */
export const FEE_ESTIMATE_EXTENSIONS = {
    [VERIFY_SIGNATURE]: { value: VERIFY_SIGNATURE_DISABLED },
};

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

/**
 * Fill every declared slot PAPI left out with the chain's own default for it.
 *
 * PAPI 2.x fills values from `extrinsic.signedExtensions[0]` with the index
 * hard-coded. Since People runtime 3004000 that is the plain pipeline, and the
 * origin extensions (`AsPerson`, `ScoreAsParticipant`, `PeopleLiteAuth`, the
 * `As*` family, `HonourAuth`, `RestrictOrigins`) live only in version 1, the one
 * the hosts encode and the implication hashes. So they arrive here with no
 * bytes at all, and `buildImplication` would rightly refuse to hash a slice
 * with holes in it.
 *
 * The rule is PAPI's own for an extension it has no special case for: encode
 * `undefined`, which is `None` for an `Option` and nothing for a unit, and
 * leave the slot alone when that does not encode. The one slot that fails is
 * `VerifyMultiSignature`, whose enum has no default; PAPI drops it too, and
 * {@link withOriginExtension} sets it explicitly when the origin is unsigned,
 * or the host fills it when signing. Slots already present are never touched:
 * PAPI's value for a slot it knows (the nonce, the era, the tip) is the one the
 * extrinsic will carry.
 *
 * Exported for `bind-lite-alias.ts`'s tests; not part of the package surface.
 */
/**
 * PAPI's default for a slot it has no case for: `encode(undefined)`, and the
 * slot is dropped when that throws. Not {@link encodeChecked}: a `bool` slot
 * such as `RestrictOrigins` encodes `undefined` as `false`, which does not
 * round-trip to `undefined` and is exactly the byte PAPI sends for it.
 */
function defaultBytes(codec: TypeCodec): Uint8Array {
    const [encode, decode] = codec;
    const bytes = encode(undefined);
    decode(bytes);
    return bytes;
}

export function withDeclaredDefaults(
    pipeline: ExtensionPipeline,
    extensions: PapiSignedExtensions,
): PapiSignedExtensions {
    let next = extensions;
    for (const slot of pipeline.extensions) {
        if (slot.identifier in next) continue;
        let value: Uint8Array;
        let additionalSigned: Uint8Array;
        try {
            value = defaultBytes(pipeline.codec(slot.type));
            additionalSigned = defaultBytes(pipeline.codec(slot.implicit));
        } catch {
            // No default for this slot. Left out, as PAPI leaves it out, for
            // whoever fills it by name: the wrapper, or the signing host.
            continue;
        }
        next = {
            ...next,
            [slot.identifier]: { identifier: slot.identifier, value, additionalSigned },
        };
    }
    if (next === extensions) return extensions;
    // Declared order, for the same reason `withSlot` keeps it.
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

/** Named fields, because a bare `true` in argument position says nothing. */
export interface OriginExtensionSpec<Value> {
    identifier: string;
    /** Takes over `VerifyMultiSignature`, which is what makes the origin `None`. */
    unsigned: boolean;
    encode: (pipeline: ExtensionPipeline, value: Value) => Uint8Array;
    /** Called once every other slot holds its final value; the proof variants hash them. */
    buildValue: (
        pipeline: ExtensionPipeline,
        callData: Uint8Array,
        extensions: PapiSignedExtensions,
        aliasAccount: Uint8Array,
    ) => Promise<Value>;
}

/**
 * Wrap a signer so its transactions run under the origin `spec.identifier` grants.
 *
 * The step order below is the fragile part, and getting it wrong produces a bad
 * proof with nothing local to read. `spec.identifier` goes last because its own
 * value is outside its own hash, which is what makes the proof step orderable.
 */
export function withOriginExtension<Value>(
    signer: PolkadotSigner,
    spec: OriginExtensionSpec<Value>,
): PolkadotSigner {
    const pipelineFor = cachedPipelineReader();

    return {
        publicKey: signer.publicKey,
        signBytes: (data) => signer.signBytes(data),
        async signTx(callData, signedExtensions, metadata, atBlockNumber, hasher) {
            const pipeline = pipelineFor(metadata);
            // PAPI filled the slots of pipeline version 0; the encoding pipeline
            // may declare more. Defaults first, so every later step sees them.
            let extensions = withDeclaredDefaults(pipeline, signedExtensions);

            if (pipeline.extensions.some((slot) => slot.identifier === RESTRICT_ORIGINS)) {
                extensions = withSlot(
                    pipeline,
                    extensions,
                    RESTRICT_ORIGINS,
                    encodeChecked(
                        pipeline.codec(pipeline.slot(RESTRICT_ORIGINS).type),
                        RESTRICT_ORIGINS_ENABLED,
                    ),
                );
            }

            if (spec.unsigned) {
                extensions = withSlot(
                    pipeline,
                    extensions,
                    VERIFY_SIGNATURE,
                    encodeChecked(
                        pipeline.codec(pipeline.slot(VERIFY_SIGNATURE).type),
                        VERIFY_SIGNATURE_DISABLED,
                    ),
                );
            }

            const value = await spec.buildValue(pipeline, callData, extensions, signer.publicKey);

            extensions = withSlot(
                pipeline,
                extensions,
                spec.identifier,
                spec.encode(pipeline, value),
            );

            return signer.signTx(callData, extensions, metadata, atBlockNumber, hasher);
        },
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { unifyMetadata, decAnyMetadata } = await import("@polkadot-api/substrate-bindings");
    const { buildImplication } = await import("./as-person-implication.js");

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

    describe("withDeclaredDefaults", () => {
        /** The map PAPI 2.x really hands over on 3004000: version 0's slots only. */
        function versionZeroExtensions(): PapiSignedExtensions {
            const plain: string[] = unifyMetadata(
                decAnyMetadata(METADATA),
            ).extrinsic.signedExtensions[0].map((entry) => entry.identifier);
            return Object.fromEntries(
                Object.entries(papiExtensions()).filter(([key]) => plain.includes(key)),
            ) as PapiSignedExtensions;
        }

        test("fills the slots version 0 lacks with None or nothing", () => {
            const before = versionZeroExtensions();
            expect(before.AsPerson).toBeUndefined();
            expect(before.RestrictOrigins).toBeUndefined();

            const filled = withDeclaredDefaults(PIPELINE, before);
            // Option<AsPersonInfo>: None. Both halves encode from the chain's types.
            expect(filled.AsPerson?.value).toEqual(Uint8Array.from([0x00]));
            expect(filled.AsPerson?.additionalSigned).toHaveLength(0);
            // bool: false, the chain's default; the wrapper then sets it to true.
            expect(filled.RestrictOrigins?.value).toEqual(Uint8Array.from([0x00]));
            // HonourAuth and the As* family are all Option on this chain.
            for (const name of ["ScoreAsParticipant", "PeopleLiteAuth", "AsMember", "HonourAuth"]) {
                expect(filled[name]?.value).toEqual(Uint8Array.from([0x00]));
            }
        });

        test("leaves VerifyMultiSignature out, as PAPI does, for the host or the wrapper", () => {
            const filled = withDeclaredDefaults(PIPELINE, versionZeroExtensions());
            expect(filled[VERIFY_SIGNATURE]).toBeUndefined();
        });

        test("never overwrites a slot PAPI filled, and keeps declared order", () => {
            const before = versionZeroExtensions();
            const filled = withDeclaredDefaults(PIPELINE, before);
            expect(filled[CHECK_NONCE]).toBe(before[CHECK_NONCE]);
            expect(filled.CheckMetadataHash).toBe(before.CheckMetadataHash);
            const declared = PIPELINE.extensions
                .map((slot) => slot.identifier)
                .filter((identifier) => identifier in filled);
            expect(Object.keys(filled)).toEqual(declared);
        });

        test("returns the same map when nothing is missing", () => {
            const complete = papiExtensions();
            expect(withDeclaredDefaults(PIPELINE, complete)).toBe(complete);
        });

        test("makes the implication buildable from what PAPI hands over", () => {
            const before = versionZeroExtensions();
            expect(() => buildImplication(PIPELINE, Uint8Array.of(1), before, "AsPerson")).toThrow(
                AsPersonError,
            );
            const filled = withDeclaredDefaults(PIPELINE, before);
            expect(buildImplication(PIPELINE, Uint8Array.of(1), filled, "AsPerson")[0]).toBe(1);
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
