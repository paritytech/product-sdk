// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The `PeopleLiteAuth` transaction extension, encoded from the chain's own
 * metadata.
 *
 * `PeopleLiteAuth` is the lite-personhood peer of `AsPerson`: the same
 * pipeline, the same `Option`-of-an-info-enum layout, and the same
 * `(proof, ringIndex, revision, context)` tuple on its proof variants. All
 * three traps documented at the top of `as-person-codec.ts` apply here
 * unchanged, including the field-list one: the deployed runtimes carry a
 * `RevisionIndex` in both proof variants that the devnet blob predates, so
 * every value is round-tripped through the codec built from the blob actually
 * being signed against, and a chain declaring a different field list is a loud
 * `AsPersonError` rather than a structurally plausible wrong encoding.
 *
 * One variant is deliberately absent. `AsLitePerson` authenticates the
 * canonical lite account itself, which stays in host custody, so no
 * product-side signer can ever be that origin.
 */
import { bytesToHex } from "@parity/product-sdk-utils";

import {
    type ExtensionPipeline,
    checkContext,
    checkProof,
    encodeChecked,
} from "./as-person-codec.js";

/** Metadata identifier of the extension this module encodes. */
export const PEOPLE_LITE_AUTH = "PeopleLiteAuth";

/**
 * The `PeopleLiteAuthData` value to put in the extension, before encoding.
 *
 * Byte fields are `Uint8Array` throughout, including the 32-byte context. The
 * split PAPI wants between bytes and hex strings is an encoding detail and is
 * handled in {@link encodePeopleLiteAuthInfo}.
 */
export type PeopleLiteAuthValue =
    /** Signed by an account already bound to the lite alias. Needs no proof. */
    | { tag: "AsLiteAliasWithAccount"; nonce: number }
    /** No signature. The chain accepts this only for `PeopleLite.set_alias_account`. */
    | {
          tag: "AsLiteAliasWithProof";
          proof: Uint8Array;
          ringIndex: number;
          revision: number;
          context: Uint8Array;
      }
    /** Signed, and moves the stored alias binding to the ring revision in force now. */
    | {
          tag: "AsLiteAliasWithAccountRevised";
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

/** Map a domain value onto the positional shape the chain's own codec expects. */
function toDynamicEnum(value: PeopleLiteAuthValue): DynamicEnum {
    // Field order is the metadata's, and the context goes in as hex because the
    // chain types it as a fixed-size array. See trap 2 in `as-person-codec.ts`.
    switch (value.tag) {
        case "AsLiteAliasWithAccount":
            return { type: value.tag, value: value.nonce };
        case "AsLiteAliasWithProof":
            return {
                type: value.tag,
                value: [
                    checkProof(value.proof),
                    value.ringIndex,
                    value.revision,
                    `0x${bytesToHex(checkContext(value.context))}`,
                ],
            };
        case "AsLiteAliasWithAccountRevised":
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
 * Encode `Some(PeopleLiteAuthData)` for the extension's declared type.
 *
 * @throws {AsPersonError} when the chain does not declare `PeopleLiteAuth`, or
 *   when the value does not round-trip through the chain's own codec — which
 *   is also how a chain declaring the pre-revision field list rejects the
 *   revision-carrying variants here.
 */
export function encodePeopleLiteAuthInfo(
    pipeline: ExtensionPipeline,
    value: PeopleLiteAuthValue,
): Uint8Array {
    return encodeChecked(
        pipeline.codec(pipeline.slot(PEOPLE_LITE_AUTH).type),
        toDynamicEnum(value),
    );
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { readExtensionPipeline } = await import("./as-person-codec.js");
    const { AsPersonError } = await import("./errors.js");

    const blob = (name: string) =>
        new Uint8Array(
            readFileSync(
                new URL(`../../descriptors/.papi/metadata/${name}.scale`, import.meta.url),
            ),
        );

    const PASEO = readExtensionPipeline(blob("paseo_individuality"));
    const PREVIEWNET = readExtensionPipeline(blob("previewnet_individuality"));
    // The devnet blob predates the RevisionIndex field on the proof variants,
    // so it is a real negative case for the deployed field list.
    const DEVNET = readExtensionPipeline(blob("devnet_individuality"));

    /** Local hex formatter, deliberately not the one the code under test uses. */
    const hex = (bytes: Uint8Array) =>
        `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

    /** 32 distinct non-zero bytes, so a truncated or zeroed context is obvious. */
    const CONTEXT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const CONTEXT_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    const PROOF = Uint8Array.from([0xaa, 0xbb, 0xcc]);

    describe("the pipeline slot", () => {
        test("every individuality chain declares PeopleLiteAuth right after GameAsInvited", () => {
            for (const pipeline of [PASEO, PREVIEWNET, DEVNET]) {
                expect(pipeline.indexOf(PEOPLE_LITE_AUTH)).toBe(6);
                expect(pipeline.indexOf("GameAsInvited")).toBe(5);
            }
        });
    });

    describe("encodePeopleLiteAuthInfo", () => {
        test("encodes AsLiteAliasWithAccount as Some, variant 1, u32 nonce", () => {
            // Variant 1, not 0: AsLitePerson holds index 0 even though this
            // module never encodes it.
            const bytes = encodePeopleLiteAuthInfo(PASEO, {
                tag: "AsLiteAliasWithAccount",
                nonce: 7,
            });
            expect(hex(bytes)).toBe("0x010107000000");
        });

        test("encodes AsLiteAliasWithProof with the revision index the chain declares", () => {
            const bytes = encodePeopleLiteAuthInfo(PASEO, {
                tag: "AsLiteAliasWithProof",
                proof: PROOF,
                ringIndex: 4,
                revision: 5,
                context: CONTEXT,
            });
            // Some, variant 2, compact-3 proof, ring u32, revision u32, 32-byte
            // context — byte-identical to the hand encoder verified on
            // previewnet (dim2's `encodeLiteAuthWithProof`).
            expect(hex(bytes)).toBe(`0x01020caabbcc0400000005000000${CONTEXT_HEX}`);
            expect(bytes).toHaveLength(46);
        });

        test("encodes AsLiteAliasWithAccountRevised with the nonce first", () => {
            const bytes = encodePeopleLiteAuthInfo(PASEO, {
                tag: "AsLiteAliasWithAccountRevised",
                nonce: 9,
                proof: PROOF,
                ringIndex: 4,
                revision: 5,
                context: CONTEXT,
            });
            expect(hex(bytes)).toBe(`0x0103090000000caabbcc0400000005000000${CONTEXT_HEX}`);
        });

        test("previewnet and paseo agree on the encoding", () => {
            // Previewnet is the chain the two-transaction lite flow was verified
            // on, so its blob is pinned alongside the descriptor chain's.
            for (const value of [
                { tag: "AsLiteAliasWithAccount", nonce: 7 },
                {
                    tag: "AsLiteAliasWithProof",
                    proof: PROOF,
                    ringIndex: 4,
                    revision: 5,
                    context: CONTEXT,
                },
            ] as const) {
                expect(hex(encodePeopleLiteAuthInfo(PREVIEWNET, value))).toBe(
                    hex(encodePeopleLiteAuthInfo(PASEO, value)),
                );
            }
        });

        test("carries the full 32-byte context, not a truncated one", () => {
            const bytes = encodePeopleLiteAuthInfo(PASEO, {
                tag: "AsLiteAliasWithProof",
                proof: PROOF,
                ringIndex: 4,
                revision: 5,
                context: CONTEXT,
            });
            expect(hex(bytes).endsWith(CONTEXT_HEX)).toBe(true);
        });

        test("rejects a proof variant on a chain without the revision field", () => {
            // Devnet's PeopleLiteAuthData predates RevisionIndex. An encoder
            // that guessed the field list would emit a structurally plausible
            // value there; the round trip through the chain's own codec is what
            // turns that into a loud error instead.
            for (const value of [
                {
                    tag: "AsLiteAliasWithProof",
                    proof: PROOF,
                    ringIndex: 4,
                    revision: 5,
                    context: CONTEXT,
                },
                {
                    tag: "AsLiteAliasWithAccountRevised",
                    nonce: 9,
                    proof: PROOF,
                    ringIndex: 4,
                    revision: 5,
                    context: CONTEXT,
                },
            ] as const) {
                expect(() => encodePeopleLiteAuthInfo(DEVNET, value)).toThrow(AsPersonError);
            }
        });

        test("the account variant still encodes on that chain", () => {
            // Proves the rejection above is about the field list, not a blob
            // this encoder simply cannot work with.
            const bytes = encodePeopleLiteAuthInfo(DEVNET, {
                tag: "AsLiteAliasWithAccount",
                nonce: 7,
            });
            expect(hex(bytes)).toBe("0x010107000000");
        });

        test("throws for a chain that does not declare PeopleLiteAuth", () => {
            const assetHub = readExtensionPipeline(blob("paseo_asset_hub"));
            expect(() =>
                encodePeopleLiteAuthInfo(assetHub, { tag: "AsLiteAliasWithAccount", nonce: 1 }),
            ).toThrow(AsPersonError);
            expect(() =>
                encodePeopleLiteAuthInfo(assetHub, { tag: "AsLiteAliasWithAccount", nonce: 1 }),
            ).toThrow(/does not declare the PeopleLiteAuth/);
        });

        test("rejects a context that is not 32 bytes", () => {
            // The round-trip guard provably cannot catch this: PAPI's fixed-size
            // codec validates no width. Same guard, same reason as AsPerson.
            for (const length of [0, 31, 33, 64]) {
                expect(() =>
                    encodePeopleLiteAuthInfo(PASEO, {
                        tag: "AsLiteAliasWithProof",
                        proof: PROOF,
                        ringIndex: 4,
                        revision: 5,
                        context: new Uint8Array(length),
                    }),
                ).toThrow(AsPersonError);
            }
        });

        test("rejects an empty proof", () => {
            expect(() =>
                encodePeopleLiteAuthInfo(PASEO, {
                    tag: "AsLiteAliasWithProof",
                    proof: new Uint8Array(),
                    ringIndex: 4,
                    revision: 5,
                    context: CONTEXT,
                }),
            ).toThrow(AsPersonError);
        });

        test("never puts the value in the error message", () => {
            // A contextual alias is pseudonymous identity. It must not reach a
            // log line through a thrown message.
            try {
                encodePeopleLiteAuthInfo(PASEO, {
                    tag: "AsLiteAliasWithProof",
                    proof: PROOF,
                    ringIndex: 4,
                    revision: 5,
                    context: CONTEXT.slice(0, 31),
                });
                expect.unreachable("should have thrown");
            } catch (error) {
                expect((error as Error).message).not.toContain("0102");
                expect((error as Error).message).not.toContain("aabbcc");
            }
        });
    });
}
