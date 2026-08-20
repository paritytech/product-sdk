// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The call implication: the bytes a person-origin proof is bound to.
 *
 * An origin-modifying extension does not sign the whole transaction. It signs
 * its *implication*, which is the call plus everything in the extension pipeline
 * that comes **after** the extension itself:
 *
 * ```
 * implication = u8(pipelineVersion) ++ callData
 *            ++ concat(value    of extensions after this one)
 *            ++ concat(implicit of extensions after this one)
 * message     = blake2_256(implication)
 * ```
 *
 * Three consequences, and each one is a way to get a bad proof with nothing
 * local to read:
 *
 * 1. **The slice starts after the extension, not at it.** `AsPerson`'s own value
 *    is outside its own hash. That is what makes the whole design work: the
 *    implication can be hashed, sent for a proof, and the proof then written into
 *    a slot the hash never covered.
 * 2. **Everything after it is inside the hash**, including `RestrictOrigins`,
 *    which this package has to set to `true`. So every slot must hold its final
 *    value before the implication is built.
 * 3. **The pipeline is per chain.** Paseo declares 22 extensions, the devnet 23.
 *    The slice is computed from the metadata each time, never from a constant.
 *
 * Layout confirmed three ways, and they agree: `frame-decode`'s
 * `encode_v5_signer_payload_with_info`, `ImplicationParts` in `sp-runtime`
 * (a plain `Encode` derive, so plain concatenation), and the individuality
 * runtime's own integration tests, which build it by hand as
 * `(0u8, &call), &rest_ext, &rest_ext.implicit()`.
 *
 * Nothing here is `AsPerson`-specific beyond a default argument: every
 * origin-modifying extension on this chain is bound the same way.
 */
import { blake2b256, concatBytes } from "@parity/product-sdk-utils";
import { str, u8, u32 } from "@polkadot-api/substrate-bindings";
import type { PolkadotSigner } from "polkadot-api";

import { AS_PERSON, type ExtensionPipeline } from "./as-person-codec.js";
import { AsPersonError } from "./errors.js";

/**
 * The signed-extensions map PAPI hands to `PolkadotSigner.signTx`, keyed by
 * extension identifier.
 *
 * Derived from `PolkadotSigner` rather than restated, so a PAPI change shows up
 * as a type error here instead of a silent shape mismatch. Same idiom as
 * `packages/terminal/src/signer.ts`.
 */
export type PapiSignedExtensions = Parameters<PolkadotSigner["signTx"]>[1];

/**
 * Build the implication bytes for the extension named `identifier`.
 *
 * @param pipeline - the chain's extension pipeline, from `readExtensionPipeline`.
 * @param callData - the SCALE-encoded call, as PAPI passes it to `signTx`.
 * @param extensions - the signed-extensions map, with every slot already holding
 *   its final value. Patch first, then build: see consequence 2 above.
 * @param identifier - which extension's implication to build. Defaults to
 *   `AsPerson`.
 * @throws {AsPersonError} when the chain does not declare `identifier`, or when
 *   an extension inside the slice is missing from `extensions`.
 */
export function buildImplication(
    pipeline: ExtensionPipeline,
    callData: Uint8Array,
    extensions: PapiSignedExtensions,
    identifier: string = AS_PERSON,
): Uint8Array {
    // `indexOf` throws when the chain does not declare it, which is the check
    // that keeps a wrong slice from being computed off index -1.
    const after = pipeline.extensions.slice(pipeline.indexOf(identifier) + 1);

    const part = (slotName: string, pick: "value" | "additionalSigned") => {
        const supplied = extensions[slotName];
        if (!supplied) {
            // Not skipped. The node recomputes this hash from the decoded
            // extrinsic, where every declared extension has bytes, so quietly
            // leaving one out signs a payload the node will not reproduce.
            // Extension identifiers are protocol metadata, safe to name.
            throw new AsPersonError(
                `signed extension ${slotName} is missing, so the implication cannot be built`,
            );
        }
        return supplied[pick];
    };

    return concatBytes(
        u8.enc(pipeline.version),
        callData,
        ...after.map((slot) => part(slot.identifier, "value")),
        ...after.map((slot) => part(slot.identifier, "additionalSigned")),
    );
}

/**
 * The message a proof for `identifier` must be generated over: blake2-256 of the
 * implication.
 *
 * This is the value to hand to `createRingVRFProof`. Callers must not choose it.
 */
export function implicationMessage(
    pipeline: ExtensionPipeline,
    callData: Uint8Array,
    extensions: PapiSignedExtensions,
    identifier: string = AS_PERSON,
): Uint8Array {
    return blake2b256(buildImplication(pipeline, callData, extensions, identifier));
}

/**
 * The message for `AsPersonalAliasWithAccountRevised`, which binds more than the
 * implication.
 *
 * The pallet hashes the encoded tuple
 * `(implication, "revise", aliasAccount, nonce)`. A SCALE tuple is the
 * concatenation of its fields, so this is the implication followed by a
 * length-prefixed `"revise"`, the 32-byte account id, and the nonce as a plain
 * little-endian `u32`.
 *
 * The nonce is a plain `u32` here and a `Compact<u32>` in the `CheckNonce` slot.
 * Same number, two widths, and confusing them is silent.
 *
 * @param implication - from {@link buildImplication}, not the hash of it.
 * @param aliasAccount - the 32-byte account id the alias is bound to.
 * @param nonce - that account's nonce.
 * @throws {AsPersonError} when `aliasAccount` is not 32 bytes.
 */
export function reviseMessage(
    implication: Uint8Array,
    aliasAccount: Uint8Array,
    nonce: number,
): Uint8Array {
    if (aliasAccount.length !== ACCOUNT_ID_BYTES) {
        // The length, not the value: an account id is identifying data.
        throw new AsPersonError("alias account id is not 32 bytes");
    }

    return blake2b256(
        concatBytes(
            implication,
            // `str` prefixes the compact length, exactly as `&str`'s Encode does.
            str.enc(REVISE_LABEL),
            // `AccountId32` encodes as its 32 raw bytes, with no length prefix.
            aliasAccount,
            u32.enc(nonce),
        ),
    );
}

/** The domain label the pallet mixes in for the revised-alias variant. */
const REVISE_LABEL = "revise";

/** `AccountId32`, the account id width on this chain. */
const ACCOUNT_ID_BYTES = 32;

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { bytesToHex } = await import("@parity/product-sdk-utils");
    const { readExtensionPipeline } = await import("./as-person-codec.js");

    const blob = (name: string) =>
        new Uint8Array(
            readFileSync(
                new URL(`../../descriptors/.papi/metadata/${name}.scale`, import.meta.url),
            ),
        );

    const PASEO = readExtensionPipeline(blob("paseo_individuality"));
    const DEVNET = readExtensionPipeline(blob("devnet_individuality"));

    const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;

    /** `People.set_alias_account` is pallet 51, call 1. The tail is a marker. */
    const CALL_DATA = Uint8Array.from([0x33, 0x01, 0xaa]);

    /**
     * A map where every slot's bytes encode its own position: value `[i]`,
     * implicit `[100 + i]`. An off-by-one in the slice then shows up as a wrong
     * byte at a readable offset instead of an opaque hash mismatch.
     */
    function positionalExtensions(pipeline: ExtensionPipeline): PapiSignedExtensions {
        return Object.fromEntries(
            pipeline.extensions.map((slot, index) => [
                slot.identifier,
                {
                    identifier: slot.identifier,
                    value: Uint8Array.from([index]),
                    additionalSigned: Uint8Array.from([100 + index]),
                },
            ]),
        ) as PapiSignedExtensions;
    }

    /** The same map minus one slot, which is how PAPI reports a dropped one. */
    function withoutSlot(
        extensions: PapiSignedExtensions,
        identifier: string,
    ): PapiSignedExtensions {
        return Object.fromEntries(
            Object.entries(extensions).filter(([key]) => key !== identifier),
        ) as PapiSignedExtensions;
    }

    describe("buildImplication", () => {
        test("is version, call, then values and implicits of the slice after AsPerson", () => {
            // Hand-derived, not computed from the pipeline, so the test is not
            // circular. AsPerson is at 2 and paseo declares 22 extensions, so the
            // slice is indices 3 to 21: nineteen values then nineteen implicits.
            const expected =
                "0x00" + // pipeline version
                "3301aa" + // call data
                "030405060708090a0b0c0d0e0f101112131415" + // values 3..21
                "6768696a6b6c6d6e6f70717273747576777879"; // implicits 103..121

            expect(hex(buildImplication(PASEO, CALL_DATA, positionalExtensions(PASEO)))).toBe(
                expected,
            );
        });

        test("excludes AsPerson's own value and everything before it", () => {
            // The single most important property in this file. Bytes 0x00 to 0x02
            // are the slots at indices 0, 1 and 2, and none may appear.
            const implication = buildImplication(PASEO, CALL_DATA, positionalExtensions(PASEO));
            const body = implication.slice(1 + CALL_DATA.length);

            expect(Array.from(body)).not.toContain(0x00); // UnitTransactionExtension
            expect(Array.from(body)).not.toContain(0x01); // VerifyMultiSignature
            expect(Array.from(body)).not.toContain(0x02); // AsPerson itself
            expect(Array.from(body)).toContain(0x03); // first slot after it
        });

        test("opens with the pipeline version byte", () => {
            const implication = buildImplication(PASEO, CALL_DATA, positionalExtensions(PASEO));
            expect(implication[0]).toBe(PASEO.version);
            expect(implication[0]).toBe(0);
        });

        test("values come before implicits, not interleaved", () => {
            // Interleaving is the other plausible layout and it hashes to
            // something the node never recomputes.
            const implication = buildImplication(PASEO, CALL_DATA, positionalExtensions(PASEO));
            const body = Array.from(implication.slice(1 + CALL_DATA.length));
            expect(body.slice(0, 19).every((byte) => byte < 100)).toBe(true);
            expect(body.slice(19).every((byte) => byte >= 100)).toBe(true);
        });

        test("follows the chain's own pipeline length rather than a constant", () => {
            // The devnet declares one extension more than paseo, so the same call
            // and the same rule must produce a longer implication there.
            const onPaseo = buildImplication(PASEO, CALL_DATA, positionalExtensions(PASEO));
            const onDevnet = buildImplication(DEVNET, CALL_DATA, positionalExtensions(DEVNET));

            expect(PASEO.extensions).toHaveLength(22);
            expect(DEVNET.extensions).toHaveLength(23);
            // 19 slots on paseo, 20 on the devnet, each contributing two bytes.
            expect(onPaseo).toHaveLength(1 + CALL_DATA.length + 19 * 2);
            expect(onDevnet).toHaveLength(1 + CALL_DATA.length + 20 * 2);
        });

        test("builds the implication for any origin-modifying extension", () => {
            // Generalization: the rule is not AsPerson's. GameAsInvited sits at
            // index 5, so its slice is shorter by three.
            const gameAsInvited = buildImplication(
                PASEO,
                CALL_DATA,
                positionalExtensions(PASEO),
                "GameAsInvited",
            );
            expect(PASEO.indexOf("GameAsInvited")).toBe(5);
            expect(gameAsInvited).toHaveLength(1 + CALL_DATA.length + 16 * 2);
            expect(hex(gameAsInvited).startsWith("0x003301aa" + "060708")).toBe(true);
        });

        test("throws for an extension the chain does not declare", () => {
            expect(() =>
                buildImplication(PASEO, CALL_DATA, positionalExtensions(PASEO), "NotAnExtension"),
            ).toThrow(AsPersonError);
        });

        test("throws when a slot inside the slice has no bytes", () => {
            // Silently skipping it would sign a payload the node cannot
            // reproduce, because the node reads every declared slot.
            const extensions = withoutSlot(positionalExtensions(PASEO), "CheckNonce");

            expect(() => buildImplication(PASEO, CALL_DATA, extensions)).toThrow(AsPersonError);
            expect(() => buildImplication(PASEO, CALL_DATA, extensions)).toThrow(/CheckNonce/);
        });

        test("ignores a slot missing from before the slice", () => {
            // PAPI drops VerifyMultiSignature whenever the host is to sign, and
            // that slot is before the cut, so it must not matter here.
            const extensions = positionalExtensions(PASEO);

            expect(
                buildImplication(PASEO, CALL_DATA, withoutSlot(extensions, "VerifyMultiSignature")),
            ).toEqual(buildImplication(PASEO, CALL_DATA, extensions));
        });
    });

    describe("implicationMessage", () => {
        test("is the blake2-256 of the implication", () => {
            const extensions = positionalExtensions(PASEO);
            expect(implicationMessage(PASEO, CALL_DATA, extensions)).toEqual(
                blake2b256(buildImplication(PASEO, CALL_DATA, extensions)),
            );
        });

        test("is 32 bytes, which is what the proof call expects", () => {
            expect(implicationMessage(PASEO, CALL_DATA, positionalExtensions(PASEO))).toHaveLength(
                32,
            );
        });

        test("changes when any byte inside the slice changes", () => {
            // The whole point of the hash: a different tip, nonce or era must
            // produce a different message.
            const extensions = positionalExtensions(PASEO);
            const before = implicationMessage(PASEO, CALL_DATA, extensions);
            extensions.CheckNonce = {
                ...extensions.CheckNonce,
                value: Uint8Array.from([0xff]),
            };
            expect(implicationMessage(PASEO, CALL_DATA, extensions)).not.toEqual(before);
        });

        test("does not change when a slot before the slice changes", () => {
            // AsPerson's own value is outside its own hash. This is what lets the
            // proof be written back in after the message is computed.
            const extensions = positionalExtensions(PASEO);
            const before = implicationMessage(PASEO, CALL_DATA, extensions);
            extensions.AsPerson = {
                ...extensions.AsPerson,
                value: Uint8Array.from([0x01, 0x00, 0x07, 0x00, 0x00, 0x00]),
            };
            expect(implicationMessage(PASEO, CALL_DATA, extensions)).toEqual(before);
        });
    });

    describe("reviseMessage", () => {
        const IMPLICATION = Uint8Array.from([0xde, 0xad]);
        const ACCOUNT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

        test("hashes implication, length-prefixed label, account and plain u32 nonce", () => {
            const expected = blake2b256(
                concatBytes(
                    IMPLICATION,
                    // Compact(6) then the six ASCII bytes of "revise".
                    Uint8Array.from([0x18, 0x72, 0x65, 0x76, 0x69, 0x73, 0x65]),
                    ACCOUNT,
                    // 9 as a plain little-endian u32, not a compact.
                    Uint8Array.from([0x09, 0x00, 0x00, 0x00]),
                ),
            );
            expect(reviseMessage(IMPLICATION, ACCOUNT, 9)).toEqual(expected);
        });

        test("differs from the plain implication message", () => {
            expect(reviseMessage(IMPLICATION, ACCOUNT, 9)).not.toEqual(blake2b256(IMPLICATION));
        });

        test("binds the nonce", () => {
            expect(reviseMessage(IMPLICATION, ACCOUNT, 9)).not.toEqual(
                reviseMessage(IMPLICATION, ACCOUNT, 10),
            );
        });

        test("binds the account", () => {
            const other = Uint8Array.from({ length: 32 }, (_, i) => i + 2);
            expect(reviseMessage(IMPLICATION, ACCOUNT, 9)).not.toEqual(
                reviseMessage(IMPLICATION, other, 9),
            );
        });

        test("rejects an account id that is not 32 bytes", () => {
            expect(() => reviseMessage(IMPLICATION, ACCOUNT.slice(0, 31), 9)).toThrow(
                AsPersonError,
            );
        });

        test("never puts the account in the error message", () => {
            try {
                reviseMessage(IMPLICATION, ACCOUNT.slice(0, 31), 9);
                expect.unreachable("should have thrown");
            } catch (error) {
                expect((error as Error).message).not.toContain("0102");
            }
        });
    });
}
