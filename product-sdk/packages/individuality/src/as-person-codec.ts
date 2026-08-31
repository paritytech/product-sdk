// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The `AsPerson` transaction extension, encoded from the chain's own metadata.
 *
 * Three traps live in this file. None of them is visible to the compiler, and
 * two of them fail silently.
 *
 * 1. **Encode from runtime metadata, never from a hand-written type.** The
 *    deployed `AsPersonInfo` and the one upstream in `polkadot-sdk` both have a
 *    variant named `AsPersonalAliasWithProof`, with different field lists: the
 *    deployed one carries a revision index, upstream does not. An encoder built
 *    from upstream emits a structurally plausible value with a field missing and
 *    no index mismatch to signal it. So every type id here is read from the blob
 *    the transaction is actually being signed against.
 * 2. **PAPI 2.x wants different JavaScript for two byte fields that look alike.**
 *    A `BoundedVec<u8>` takes a `Uint8Array`; a `[u8; 32]` takes a `0x` string.
 *    Hand either one the other form and it encodes without throwing, producing
 *    the wrong bytes. Callers of this module never see that: they pass bytes for
 *    both, and {@link encodeAsPersonInfo} converts. The round trip in
 *    {@link encodeChecked} catches a change to which field is which, but **not a
 *    wrong width on a fixed-size field**, because PAPI validates no width on
 *    encode or decode. That is why the context and proof lengths are checked
 *    explicitly further down.
 * 3. **The extension pipeline differs between chains that both have `AsPerson`.**
 *    Paseo declares 22 extensions, the devnet 23. Nothing may assume a count, a
 *    position, or that a given extension exists at all.
 *
 * The pipeline reader is deliberately not `AsPerson`-specific: every
 * origin-modifying extension on this chain is bound the same way, so
 * {@link readExtensionPipeline} takes an identifier rather than hard-coding one.
 */
import { bytesToHex } from "@parity/product-sdk-utils";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";

import { AsPersonError } from "./errors.js";

/** Metadata identifier of the extension this module encodes. */
export const AS_PERSON = "AsPerson";

/**
 * The only transaction-extension pipeline version this package can work with.
 *
 * Not a preference. PAPI's `getSignExtensionsCreator` reads
 * `extrinsic.signedExtensions[0]` with the index hard-coded, so version 0 is the
 * only one it can ever fill values for. Reading a different version here while
 * PAPI fills version 0 would hash a payload the node never recomputes.
 */
const SUPPORTED_PIPELINE_VERSION = 0;

/** One extension as the metadata declares it. */
export interface ExtensionSlot {
    /** Metadata identifier, e.g. `"AsPerson"`. Not the Rust type name. */
    identifier: string;
    /** Type id of the value carried in the extrinsic body. */
    type: number;
    /** Type id of the implicit data: signed, never transmitted. */
    implicit: number;
}

/** An encoder and decoder pair for one metadata type id. */
export type TypeCodec = [(value: any) => Uint8Array, (bytes: Uint8Array) => any];

/**
 * One chain's transaction-extension pipeline, resolved from one metadata blob.
 *
 * Decoding the blob is the expensive part, so callers resolve this once per
 * signing attempt and share it between the encoder and the implication builder.
 */
export interface ExtensionPipeline {
    /** The version byte that opens the signed implication. Always 0, see above. */
    version: number;
    /** Every declared extension, in the order the chain encodes them. */
    extensions: ExtensionSlot[];
    /** Build a codec for a declared type id. */
    codec(typeId: number): TypeCodec;
    /** Position of `identifier` in {@link extensions}. Throws when absent. */
    indexOf(identifier: string): number;
    /** The slot for `identifier`. Throws when absent. */
    slot(identifier: string): ExtensionSlot;
}

/**
 * Read the transaction-extension pipeline out of a raw metadata blob.
 *
 * @param metadata - the raw metadata bytes, as PAPI hands them to
 *   `PolkadotSigner.signTx`.
 * @throws {AsPersonError} when the chain declares a pipeline version this
 *   package cannot work with. See {@link SUPPORTED_PIPELINE_VERSION}.
 */
export function readExtensionPipeline(metadata: Uint8Array): ExtensionPipeline {
    const unified = unifyMetadata(decAnyMetadata(metadata));
    const declared = Object.keys(unified.extrinsic.signedExtensions).map(Number);

    // Fail loudly rather than guess. A chain declaring more than one version
    // nominates one for encoding, and this package cannot see which: the choice
    // lives in the node's own encoder. Guessing would produce a wrong first byte
    // in every signed implication, which reaches the caller as an opaque bad
    // proof with nothing local to read.
    if (declared.length !== 1 || declared[0] !== SUPPORTED_PIPELINE_VERSION) {
        throw new AsPersonError(
            "chain declares a transaction-extension pipeline version this package cannot encode",
        );
    }

    const extensions: ExtensionSlot[] = unified.extrinsic.signedExtensions[
        SUPPORTED_PIPELINE_VERSION
    ].map((entry) => ({
        identifier: entry.identifier,
        type: entry.type,
        implicit: entry.additionalSigned,
    }));

    const builder = getDynamicBuilder(getLookupFn(unified));

    function indexOf(identifier: string): number {
        const index = extensions.findIndex((slot) => slot.identifier === identifier);
        if (index === -1) {
            // The identifier is protocol metadata, not chain data about a person,
            // so naming it here is safe and it is the whole diagnostic value.
            throw new AsPersonError(`chain does not declare the ${identifier} extension`);
        }
        return index;
    }

    return {
        version: SUPPORTED_PIPELINE_VERSION,
        extensions,
        codec: (typeId) => builder.buildDefinition(typeId) as TypeCodec,
        indexOf,
        slot: (identifier) => extensions[indexOf(identifier)],
    };
}

/**
 * The `AsPersonInfo` value to put in the extension, before encoding.
 *
 * Byte fields are `Uint8Array` throughout, including the 32-byte context. The
 * split PAPI wants between bytes and hex strings is an encoding detail and is
 * handled in {@link encodeAsPersonInfo}.
 *
 * The two identity variants are absent on purpose. `AsPersonalIdentityWithProof`
 * needs a raw sr25519 signature over the implication hash, which no host call
 * currently produces, and `AsPersonalIdentityWithAccount` has no known consumer.
 */
export type AsPersonValue =
    /** Signed by an account already bound to the alias. Needs no proof. */
    | { tag: "AsPersonalAliasWithAccount"; nonce: number }
    /** No signature. The chain accepts this only for `People.set_alias_account`. */
    | {
          tag: "AsPersonalAliasWithProof";
          proof: Uint8Array;
          ringIndex: number;
          revision: number;
          context: Uint8Array;
      }
    /** Signed, and moves the stored alias to the ring revision in force now. */
    | {
          tag: "AsPersonalAliasWithAccountRevised";
          nonce: number;
          proof: Uint8Array;
          ringIndex: number;
          revision: number;
          context: Uint8Array;
      };

/** A PAPI dynamic-codec enum value: variant name plus positional fields. */
interface DynamicEnum {
    type: string;
    value: unknown;
}

/**
 * Width the metadata declares for `Context`, the proof context.
 *
 * A constant rather than a metadata lookup, and that is a deliberate trade with
 * one thing to know: **the round-trip guard cannot check this.** PAPI's
 * fixed-size codec validates no width, on encode or decode, so a 31-byte context
 * encodes to a 45-byte extension, decodes back to the same 31 bytes, and passes
 * {@link encodeChecked} while being a value the chain cannot read. That was
 * measured against the deployed blob, not assumed.
 *
 * So this check is the only guard, and the constant is held honest from the other
 * side: a test below reads the declared array length out of the deployed metadata
 * and fails if it is ever not 32.
 */
const CONTEXT_BYTES = 32;

/**
 * Sanity ceiling on the ring VRF proof.
 *
 * The chain declares the field as a `BoundedVec`, but the bound is a type
 * parameter with no type in the metadata, so the real maximum is not recoverable
 * and this cannot be exact. It exists because PAPI's byte encoder enforces no
 * bound at all: a 100 KB proof encodes cleanly into an extrinsic the node then
 * rejects on decode. A real bandersnatch ring VRF proof is under a kilobyte, so
 * this rejects nothing legitimate while turning a silent build into a local error.
 */
const PROOF_BYTES_MAX = 8 * 1024;

/** Reject a context the chain cannot read, before it becomes wrong bytes. */
export function checkContext(context: Uint8Array): Uint8Array {
    if (context.length !== CONTEXT_BYTES) {
        // The length, never the value: a contextual alias is pseudonymous
        // identity and must not reach a log line.
        throw new AsPersonError("proof context is not 32 bytes");
    }
    return context;
}

/** Reject a proof the chain will not accept, for the reasons on the constant. */
export function checkProof(proof: Uint8Array): Uint8Array {
    if (proof.length === 0) {
        throw new AsPersonError("ring VRF proof is empty");
    }
    if (proof.length > PROOF_BYTES_MAX) {
        throw new AsPersonError("ring VRF proof is larger than the chain will accept");
    }
    return proof;
}

/** Map a domain value onto the positional shape the chain's own codec expects. */
function toDynamicEnum(value: AsPersonValue): DynamicEnum {
    // Field order is the metadata's, and the context goes in as hex because the
    // chain types it as a fixed-size array. See trap 2 at the top of this file.
    switch (value.tag) {
        case "AsPersonalAliasWithAccount":
            return { type: value.tag, value: value.nonce };
        case "AsPersonalAliasWithProof":
            return {
                type: value.tag,
                value: [
                    checkProof(value.proof),
                    value.ringIndex,
                    value.revision,
                    `0x${bytesToHex(checkContext(value.context))}`,
                ],
            };
        case "AsPersonalAliasWithAccountRevised":
            return {
                type: value.tag,
                value: [
                    value.nonce,
                    checkProof(value.proof),
                    value.ringIndex,
                    value.revision,
                    `0x${bytesToHex(checkContext(value.context))}`,
                ],
            };
    }
}

/**
 * Reduce a codec value to a form two shapes can be compared in.
 *
 * Bytes and `0x` strings both collapse to lower-case hex, so a field the codec
 * wants as hex compares equal to the same field given as bytes. Numbers and
 * bigints collapse to decimal, so a `u64` decoded as a bigint compares equal to
 * the number it was encoded from.
 */
function canonical(value: unknown): unknown {
    if (value instanceof Uint8Array) return `0x${bytesToHex(value)}`;
    if (typeof value === "string") {
        return value.startsWith("0x") ? value.toLowerCase() : value;
    }
    if (typeof value === "number" || typeof value === "bigint") return `#${value}`;
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([key, inner]) => [key, canonical(inner)]),
        );
    }
    return value;
}

/**
 * Encode with a dynamic codec, then decode the bytes back and check the value
 * survived.
 *
 * PAPI's dynamic encoders accept the wrong JavaScript shape for several SCALE
 * types and emit wrong bytes rather than throwing, so encoding alone proves
 * nothing.
 *
 * Comparing the *decoded value against the input* is what catches that.
 * Comparing bytes does not: encoding a wrong shape and then decoding and
 * re-encoding those wrong bytes reproduces them exactly, because the codec is
 * self-consistent on whatever it managed to read. That was measured, not
 * assumed, and the two `encodeChecked` rejection tests below fail if this is
 * ever weakened back to a byte comparison.
 *
 * Generic on purpose. Every origin-modifying extension on this chain is encoded
 * the same way, so the guard belongs here rather than inside one encoder.
 *
 * @throws {AsPersonError} when the value does not survive the round trip.
 */
export function encodeChecked(codec: TypeCodec, value: unknown): Uint8Array {
    const [encode, decode] = codec;

    // Both halves inside the try. PAPI's dynamic codecs throw bare `TypeError`s
    // such as "inner[tag] is not a function" for a malformed value, and this
    // function is exported, so a consumer encoding another origin extension would
    // otherwise get an error naming neither this package nor their input.
    let bytes: Uint8Array;
    let decoded: unknown;
    try {
        bytes = encode(value);
        decoded = decode(bytes);
    } catch (cause) {
        throw new AsPersonError("extension value could not be encoded for this chain", { cause });
    }

    if (JSON.stringify(canonical(decoded)) !== JSON.stringify(canonical(value))) {
        // Deliberately no values in the message. A contextual alias is
        // pseudonymous identity, and an error string is the least controlled
        // place for it to end up.
        throw new AsPersonError("encoded extension value does not round-trip");
    }

    return bytes;
}

/**
 * Encode `Some(AsPersonInfo)` for the extension's declared type.
 *
 * @throws {AsPersonError} when the chain does not declare `AsPerson`, or when
 *   the value does not round-trip through the chain's own codec.
 */
export function encodeAsPersonInfo(pipeline: ExtensionPipeline, value: AsPersonValue): Uint8Array {
    return encodeChecked(pipeline.codec(pipeline.slot(AS_PERSON).type), toDynamicEnum(value));
}

/**
 * Read the account nonce back out of an already-encoded `CheckNonce` value.
 *
 * Two variants of `AsPersonInfo` carry the nonce a second time, and the chain
 * checks them against each other. Taking it from the slot PAPI already filled
 * is what makes disagreement impossible.
 *
 * @throws {AsPersonError} when the chain does not declare `CheckNonce`.
 */
export function decodeCheckNonce(pipeline: ExtensionPipeline, encoded: Uint8Array): number {
    const [, decode] = pipeline.codec(pipeline.slot("CheckNonce").type);
    return decode(encoded) as number;
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");

    // The real deployed blobs, not hand-built fixtures. A descriptor
    // regeneration that moves the extension or changes a field list fails these
    // tests instead of passing silently. This is the one place a test in this
    // package reaches outside it.
    const blob = (name: string) =>
        new Uint8Array(
            readFileSync(
                new URL(`../../descriptors/.papi/metadata/${name}.scale`, import.meta.url),
            ),
        );

    const PASEO = blob("paseo_individuality");
    const DEVNET = blob("devnet_individuality");
    // Asset Hub has RestrictOrigins but no AsPerson, so it is a real negative
    // case rather than a synthesized one.
    const ASSET_HUB = blob("paseo_asset_hub");

    /**
     * Local hex formatter, deliberately not the `bytesToHex` the code above uses.
     * A test asserting hex output should not share its formatter with the code
     * under test, and it keeps this package's fast test loop off a sibling.
     */
    const hex = (bytes: Uint8Array) =>
        `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

    /** 32 distinct non-zero bytes, so a truncated or zeroed context is obvious. */
    const CONTEXT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const CONTEXT_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    const PROOF = Uint8Array.from([0xaa, 0xbb, 0xcc]);

    describe("readExtensionPipeline", () => {
        test("reads the pipeline version from the blob rather than assuming it", () => {
            expect(readExtensionPipeline(PASEO).version).toBe(0);
            expect(readExtensionPipeline(DEVNET).version).toBe(0);
        });

        test("finds AsPerson at its declared position", () => {
            expect(readExtensionPipeline(PASEO).indexOf(AS_PERSON)).toBe(2);
            expect(readExtensionPipeline(DEVNET).indexOf(AS_PERSON)).toBe(2);
        });

        test("the two live chains agree on AsPerson but not on the pipeline length", () => {
            // The argument for reading everything from metadata: both chains
            // carry AsPerson at the same index, and the slice after it differs.
            expect(readExtensionPipeline(PASEO).extensions).toHaveLength(22);
            expect(readExtensionPipeline(DEVNET).extensions).toHaveLength(23);
        });

        test("keeps the extensions in the order the chain encodes them", () => {
            const { extensions } = readExtensionPipeline(PASEO);
            expect(extensions.slice(0, 4).map((slot) => slot.identifier)).toEqual([
                "UnitTransactionExtension",
                "VerifyMultiSignature",
                "AsPerson",
                "AsProofOfInkParticipant",
            ]);
            expect(extensions[12].identifier).toBe("RestrictOrigins");
            expect(extensions[18].identifier).toBe("CheckNonce");
        });

        test("carries both type ids for a slot", () => {
            const slot = readExtensionPipeline(PASEO).slot(AS_PERSON);
            expect(slot.identifier).toBe(AS_PERSON);
            expect(typeof slot.type).toBe("number");
            expect(typeof slot.implicit).toBe("number");
        });

        test("throws a named error for an extension the chain does not declare", () => {
            const pipeline = readExtensionPipeline(ASSET_HUB);
            expect(() => pipeline.indexOf(AS_PERSON)).toThrow(AsPersonError);
            expect(() => pipeline.indexOf(AS_PERSON)).toThrow(/does not declare the AsPerson/);
        });

        test("a chain without AsPerson still resolves its other extensions", () => {
            // Proves the negative case above is about AsPerson specifically, not
            // a blob this reader simply cannot parse.
            const pipeline = readExtensionPipeline(ASSET_HUB);
            expect(pipeline.extensions).toHaveLength(18);
            expect(pipeline.indexOf("CheckNonce")).toBe(12);
        });
    });

    describe("encodeAsPersonInfo", () => {
        const pipeline = readExtensionPipeline(PASEO);

        test("encodes AsPersonalAliasWithAccount as Some, variant 0, u32 nonce", () => {
            const bytes = encodeAsPersonInfo(pipeline, {
                tag: "AsPersonalAliasWithAccount",
                nonce: 7,
            });
            expect(hex(bytes)).toBe("0x010007000000");
        });

        test("encodes AsPersonalAliasWithProof with the revision index the chain declares", () => {
            const bytes = encodeAsPersonInfo(pipeline, {
                tag: "AsPersonalAliasWithProof",
                proof: PROOF,
                ringIndex: 4,
                revision: 5,
                context: CONTEXT,
            });
            // Some, variant 1, compact-3 proof, ring u32, revision u32, 32-byte context.
            // The revision field is the one an upstream-derived encoder omits.
            expect(hex(bytes)).toBe(`0x01010caabbcc0400000005000000${CONTEXT_HEX}`);
            expect(bytes).toHaveLength(46);
        });

        test("encodes AsPersonalAliasWithAccountRevised with the nonce first", () => {
            const bytes = encodeAsPersonInfo(pipeline, {
                tag: "AsPersonalAliasWithAccountRevised",
                nonce: 9,
                proof: PROOF,
                ringIndex: 4,
                revision: 5,
                context: CONTEXT,
            });
            expect(hex(bytes)).toBe(`0x0104090000000caabbcc0400000005000000${CONTEXT_HEX}`);
        });

        test("carries the full 32-byte context, not a truncated one", () => {
            // The failure this pins: handing PAPI a Uint8Array for a fixed-size
            // array encodes 16 mangled bytes and does not throw.
            const bytes = encodeAsPersonInfo(pipeline, {
                tag: "AsPersonalAliasWithProof",
                proof: PROOF,
                ringIndex: 4,
                revision: 5,
                context: CONTEXT,
            });
            expect(hex(bytes).endsWith(CONTEXT_HEX)).toBe(true);
        });

        test("throws for a chain that does not declare AsPerson", () => {
            const assetHub = readExtensionPipeline(ASSET_HUB);
            expect(() =>
                encodeAsPersonInfo(assetHub, { tag: "AsPersonalAliasWithAccount", nonce: 1 }),
            ).toThrow(AsPersonError);
        });

        test("rejects a context that is not 32 bytes", () => {
            // encodeChecked provably cannot catch this: PAPI's fixed-size codec
            // validates no width, so a short context round-trips cleanly into an
            // extension one byte too short for the chain to read.
            for (const length of [0, 31, 33, 64]) {
                expect(() =>
                    encodeAsPersonInfo(pipeline, {
                        tag: "AsPersonalAliasWithProof",
                        proof: PROOF,
                        ringIndex: 4,
                        revision: 5,
                        context: new Uint8Array(length),
                    }),
                ).toThrow(AsPersonError);
            }
        });

        test("the chain still declares the context as 32 bytes", () => {
            // Holds CONTEXT_BYTES honest from the metadata side, since the
            // round-trip guard cannot. A runtime that widens Context fails here
            // instead of silently encoding the wrong number of bytes.
            const unified = unifyMetadata(decAnyMetadata(PASEO));
            const lookup = new Map(unified.lookup.map((entry) => [entry.id, entry]));
            const asPersonInfo = lookup.get(
                // AsPerson is a newtype over Option<AsPersonInfo>; walk in.
                (
                    lookup.get(
                        (lookup.get(pipeline.slot(AS_PERSON).type)!.def as any).value[0].type,
                    )!.def as any
                ).value[1].fields[0].type,
            )!;
            const contextField = (asPersonInfo.def as any).value.find(
                (variant: any) => variant.name === "AsPersonalAliasWithProof",
            ).fields[3];
            const contextType = lookup.get(contextField.type)!;

            expect(contextField.typeName).toBe("Context");
            expect((contextType.def as any).tag).toBe("array");
            expect((contextType.def as any).value.len).toBe(32);
        });
    });

    describe("encodeChecked", () => {
        const pipeline = readExtensionPipeline(PASEO);
        const asPerson = () => pipeline.codec(pipeline.slot(AS_PERSON).type);

        test("passes a value the codec round-trips", () => {
            const bytes = encodeChecked(asPerson(), {
                type: "AsPersonalAliasWithAccount",
                value: 7,
            });
            expect(hex(bytes)).toBe("0x010007000000");
        });

        test("rejects a fixed-size field handed raw bytes instead of hex", () => {
            // The exact §3.4 trap. Without this guard PAPI emits 30 bytes of
            // garbage for a 46-byte value and raises nothing.
            expect(() =>
                encodeChecked(asPerson(), {
                    type: "AsPersonalAliasWithProof",
                    value: [PROOF, 4, 5, CONTEXT],
                }),
            ).toThrow(AsPersonError);
        });

        test("rejects a variable-length field handed hex instead of raw bytes", () => {
            expect(() =>
                encodeChecked(asPerson(), {
                    type: "AsPersonalAliasWithProof",
                    value: [hex(PROOF), 4, 5, `0x${CONTEXT_HEX}`],
                }),
            ).toThrow(AsPersonError);
        });

        test("reports a malformed value as this package's error, not a raw codec error", () => {
            // This function is exported, so a consumer encoding another origin
            // extension would otherwise see PAPI internals such as
            // "inner[tag] is not a function".
            for (const bad of [
                { type: "NotAVariant", value: 1 },
                { type: "AsPersonalAliasWithProof" },
                { type: "AsPersonalAliasWithProof", value: [1] },
                null,
                "nope",
            ]) {
                expect(() => encodeChecked(asPerson(), bad)).toThrow(AsPersonError);
            }
        });

        test("never puts the value in the error message", () => {
            // A contextual alias is pseudonymous identity. It must not reach a
            // log line through a thrown message.
            try {
                encodeChecked(asPerson(), {
                    type: "AsPersonalAliasWithProof",
                    value: [PROOF, 4, 5, CONTEXT],
                });
                expect.unreachable("should have thrown");
            } catch (error) {
                expect((error as Error).message).not.toContain(CONTEXT_HEX);
                expect((error as Error).message).not.toContain("aabbcc");
            }
        });
    });

    describe("decodeCheckNonce", () => {
        const pipeline = readExtensionPipeline(PASEO);
        const encodeNonce = (nonce: number) =>
            pipeline.codec(pipeline.slot("CheckNonce").type)[0](nonce);

        test("reads back the compact nonce PAPI put in the body", () => {
            // Compact encoding changes width at 64 and 16384, so the round trip
            // is checked across all three ranges rather than at one value.
            for (const nonce of [0, 1, 7, 63, 64, 16383, 16384, 4294967295]) {
                expect(decodeCheckNonce(pipeline, encodeNonce(nonce))).toBe(nonce);
            }
        });

        test("nonce 7 is one compact byte, not a u32", () => {
            // Pins that this is CheckNonce's own Compact<u32> and not the plain
            // u32 the AsPerson variant carries. Confusing the two is silent.
            expect(hex(encodeNonce(7))).toBe("0x1c");
        });
    });
}
