// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared plumbing for signers that write an origin-modifying transaction
 * extension.
 *
 * `withAsPerson`, `withLiteAlias` and `withScoreParticipant` differ only in
 * which extension they fill and how its value is built. Everything else is
 * identical, and identical in ways that are easy to get subtly wrong, so it
 * lives here once: patching a slot while keeping the declared order, reading
 * the nonce back out of `CheckNonce`, requesting a ring VRF proof defensively,
 * caching the decoded pipeline, and naming the pipeline version for the host. Internal to the package on purpose:
 * these are implementation details of the three signers, not a public contract.
 *
 * The errors are `AsPersonError` throughout. It is the write half's error
 * class, predates the second extension, and callers already catch it; a
 * parallel class per extension would split one failure domain in two.
 */
import {
    type CommonSignerTxCreator,
    withCommonExtensions,
    withNonce,
} from "@polkadot-api/signers-common";
import type { TxCreator, TxPayloadV1 } from "@polkadot-api/tx-creator";
import { fromHex, toHex } from "@polkadot-api/utils";

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

/** Restricted origins are metered against an allowance; `false` rejects them outright. */
export const RESTRICT_ORIGINS_ENABLED = true;

/** `Disabled`: no signature slot, so the origin stays `None`. */
export const VERIFY_SIGNATURE_DISABLED = { type: "Disabled", value: undefined };

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
 * case is `VerifyMultiSignature`, which PAPI cannot fill and the host fills
 * itself when it signs.
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
 * 7 ms for a 435 KB blob, and PAPI hands the same metadata for every
 * transaction until the runtime upgrades. Keyed on the hex string PAPI puts on
 * the payload, so a runtime upgrade brings different metadata and cannot be
 * served a stale pipeline. One reader per wrapped signer, not module level, so
 * two wrapped signers on two chains cannot share an entry.
 */
export function cachedPipelineReader(): (metadata: string) => ExtensionPipeline {
    let cached: { metadata: string; pipeline: ExtensionPipeline } | undefined;
    return (metadata) => {
        if (cached?.metadata !== metadata) {
            cached = { metadata, pipeline: readExtensionPipeline(fromHex(metadata)) };
        }
        return cached.pipeline;
    };
}

/**
 * Run the PAPI 3 enhancers that fill the standard extensions, and keep the result.
 *
 * They fill the nonce, the era, the genesis, the runtime versions, the tip, the
 * metadata hash, and the encoding of `undefined` for every other extension any
 * pipeline declares. Each one skips an extension the payload already carries,
 * so the inner signer, which runs the same enhancers, signs exactly these bytes.
 */
async function withStandardExtensions(
    publicKey: Uint8Array,
    payload: TxPayloadV1,
    opts: unknown,
    bindings: Parameters<TxCreator>[2],
): Promise<TxPayloadV1> {
    let filled: TxPayloadV1 | undefined;
    const keep: TxCreator<[]> = async (complete) => {
        filled = complete;
        return "0x";
    };
    await withNonce(publicKey)(withCommonExtensions(keep))(payload, opts as never, bindings, false);
    if (!filled) {
        throw new AsPersonError("transaction extensions could not be filled");
    }
    return filled;
}

/** The payload extensions the pipeline declares, as bytes, in its order. */
function toExtensionMap(
    pipeline: ExtensionPipeline,
    supplied: TxPayloadV1["extensions"],
): PapiSignedExtensions {
    const byId = new Map(supplied.map((extension) => [extension.id, extension]));
    return Object.fromEntries(
        pipeline.extensions.flatMap(({ identifier }) => {
            const extension = byId.get(identifier);
            return extension
                ? [
                      [
                          identifier,
                          {
                              identifier,
                              value: fromHex(extension.extra),
                              additionalSigned: fromHex(extension.additionalSigned),
                          },
                      ],
                  ]
                : [];
        }),
    ) as PapiSignedExtensions;
}

function toPayloadExtensions(extensions: PapiSignedExtensions): TxPayloadV1["extensions"] {
    return Object.values(extensions).map(({ identifier, value, additionalSigned }) => ({
        id: identifier,
        extra: toHex(value),
        additionalSigned: toHex(additionalSigned),
    }));
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
 *
 * The inner signer receives the finished extensions and the pipeline version
 * they belong to, so a host never has to infer the version from the names.
 *
 * A fee estimate goes straight to the inner signer. It needs no proof, and a
 * proof request can prompt the user, so the call is priced as a plain account
 * transaction, a few bytes shorter than the real one.
 */
export function withOriginExtension<Value>(
    signer: CommonSignerTxCreator,
    spec: OriginExtensionSpec<Value>,
): CommonSignerTxCreator {
    const pipelineFor = cachedPipelineReader();

    const create: TxCreator<[]> = async (payload, opts, bindings, mocked) => {
        if (mocked) return signer(payload, opts as never, bindings, true);

        const standard = await withStandardExtensions(signer.publicKey, payload, opts, bindings);
        const pipeline = pipelineFor(standard.context.metadata);
        const callData = fromHex(standard.callData);
        let extensions = toExtensionMap(pipeline, standard.extensions);

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

        extensions = withSlot(pipeline, extensions, spec.identifier, spec.encode(pipeline, value));

        return signer(
            {
                ...standard,
                extensions: toPayloadExtensions(extensions),
                txExtVersion: pipeline.version,
            },
            opts as never,
            bindings,
            false,
        );
    };

    return Object.assign(create, {
        publicKey: signer.publicKey,
        signBytes: (data: Uint8Array) => signer.signBytes(data),
    }) as CommonSignerTxCreator;
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { unifyMetadata, decAnyMetadata } = await import("@polkadot-api/substrate-bindings");

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

    describe("withOriginExtension", () => {
        // People runtime 3004000 on paseo: version 0 is the plain account
        // pipeline, version 1 adds the person and origin extensions.
        const METADATA_HEX = toHex(METADATA);
        const versionZero = unifyMetadata(decAnyMetadata(METADATA)).extrinsic
            .extensionsByVersion[0];

        /** A payload holding version 0 only, filled, so no enhancer needs chain bindings. */
        const payload = (): TxPayloadV1 => ({
            version: 1,
            signer: null,
            callData: "0x3301aa",
            extensions: versionZero.map(({ identifier }, index) => ({
                id: identifier,
                extra: identifier === CHECK_NONCE ? "0x1c" : toHex(Uint8Array.of(index)),
                additionalSigned: "0x",
            })),
            txExtVersion: null,
            context: {
                metadata: METADATA_HEX,
                token: null,
                bestBlockHeight: 1,
                bestBlockHash: `0x${"11".repeat(32)}`,
                genesisHash: `0x${"22".repeat(32)}`,
            },
        });

        function spySigner() {
            const inner = vi.fn(async (_payload: TxPayloadV1, ..._rest: unknown[]) => "0xdead");
            const signer = Object.assign(inner, {
                publicKey: new Uint8Array(32).fill(7),
                signBytes: async () => new Uint8Array(64),
            }) as unknown as CommonSignerTxCreator;
            return { signer, inner };
        }

        const spec = (unsigned: boolean) => ({
            identifier: "AsPerson",
            unsigned,
            encode: () => Uint8Array.of(0x01, 0x00, 0x07, 0x00, 0x00, 0x00),
            buildValue: vi.fn(async () => ({})),
        });

        test("names the pipeline that carries the extension on the payload", async () => {
            const { signer, inner } = spySigner();
            await withOriginExtension(signer, spec(false))(payload(), {}, {} as never, false);
            const handed = inner.mock.calls[0][0];
            expect(handed.txExtVersion).toBe(PIPELINE.version);
            expect(handed.txExtVersion).toBe(1);
        });

        test("hands over every slot of that pipeline, the person ones filled", async () => {
            const { signer, inner } = spySigner();
            await withOriginExtension(signer, spec(false))(payload(), {}, {} as never, false);
            const handed = inner.mock.calls[0][0];
            const byId = Object.fromEntries(handed.extensions.map((e) => [e.id, e]));
            expect(handed.extensions.map((e) => e.id)).toEqual(
                PIPELINE.extensions
                    .map((slot) => slot.identifier)
                    .filter((identifier) => identifier !== VERIFY_SIGNATURE),
            );
            expect(byId.AsPerson.extra).toBe("0x010007000000");
            expect(byId[RESTRICT_ORIGINS].extra).toBe("0x01");
            for (const name of ["ScoreAsParticipant", "PeopleLiteAuth", "AsMember", "HonourAuth"]) {
                expect(byId[name].extra).toBe("0x00");
            }
            expect(byId[CHECK_NONCE].extra).toBe("0x1c");
        });

        test("an unsigned origin disables VerifyMultiSignature for the host", async () => {
            const { signer, inner } = spySigner();
            await withOriginExtension(signer, spec(true))(payload(), {}, {} as never, false);
            const handed = inner.mock.calls[0][0];
            expect(handed.extensions.find((e) => e.id === VERIFY_SIGNATURE)?.extra).toBe("0x00");
        });

        test("hashes over the slots the standard enhancers filled", async () => {
            const { signer } = spySigner();
            const withSpy = spec(false);
            await withOriginExtension(signer, withSpy)(payload(), {}, {} as never, false);
            const seen = withSpy.buildValue.mock.calls[0] as unknown as [
                ExtensionPipeline,
                Uint8Array,
                PapiSignedExtensions,
            ];
            expect(Object.keys(seen[2])).toContain("GameAsInvited");
            expect(seen[1]).toEqual(Uint8Array.of(0x33, 0x01, 0xaa));
        });

        test("a fee estimate reaches the inner signer untouched and asks for no proof", async () => {
            const { signer, inner } = spySigner();
            const withSpy = spec(false);
            const original = payload();
            await withOriginExtension(signer, withSpy)(original, {}, {} as never, true);
            expect(inner).toHaveBeenCalledWith(original, {}, {}, true);
            expect(withSpy.buildValue).not.toHaveBeenCalled();
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
        test("decodes a runtime once and again for different metadata", () => {
            const read = cachedPipelineReader();
            const first = read(toHex(METADATA));
            expect(read(toHex(METADATA))).toBe(first);
            const other = new Uint8Array(
                readFileSync(
                    new URL(
                        "../../descriptors/.papi/metadata/devnet_individuality.scale",
                        import.meta.url,
                    ),
                ),
            );
            expect(read(toHex(other))).not.toBe(first);
        });
    });
}
