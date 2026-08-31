// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `withScoreParticipant`: run a call as a score participant, fee-free.
 *
 * The third signer on the origin-extension machinery, and the simplest: the
 * `ScoreAsParticipant` extension turns a `Signed` origin into the participant
 * origin `Score.register` and `Game.report`'s participant arm accept, and marks
 * the call for pallet-origin-restriction's allowance metering instead of a fee
 * — a 0-balance participant account can dispatch. Unlike `AsPerson` and
 * `PeopleLiteAuth` it carries no proof and hashes nothing: its whole value is
 * `Some(nonce)`, checked by the chain against `CheckNonce`, so the underlying
 * account signature still authenticates the caller and the extension only
 * re-labels the origin.
 *
 * That is why this wraps a signer all the same: the nonce is resolved inside
 * PAPI's `createTx` and exists only in the `signTx` call, where it is read back
 * out of the `CheckNonce` slot PAPI already filled — the same rule as the two
 * sibling signers, and the reason the proposal-stage `withScoreParticipant(
 * signer, nonce)` shape was dropped: a caller-supplied nonce and the one PAPI
 * fetches can disagree, and the chain rejects the disagreement with nothing
 * local to read.
 *
 * Order inside `signTx`: `RestrictOrigins` to `true` first — the participant
 * origin is a restricted entity and that extension rejects it outright when its
 * slot says `false`, which is PAPI's default — then `ScoreAsParticipant`.
 * `VerifyMultiSignature` stays untouched: the extension requires the `Signed`
 * origin underneath, and PAPI's default (omit the slot, host signs) is exactly
 * that.
 *
 * ```ts
 * import { submitAndWatch } from "@parity/product-sdk-tx";
 * import { registerPersonhoodTx, withScoreParticipant } from "@parity/product-sdk-individuality";
 *
 * const tx = registerPersonhoodTx(chain, { memberKey, proofOfOwnership });
 * await submitAndWatch(tx, withScoreParticipant(accounts.getProductAccountSigner(account)));
 * ```
 */
import type { PolkadotSigner } from "polkadot-api";

import { type ExtensionPipeline, encodeChecked } from "./as-person-codec.js";
import { RESTRICT_ORIGINS, cachedPipelineReader, nonceFrom, withSlot } from "./origin-extension.js";

/** Metadata identifier of the extension this signer fills. */
const SCORE_AS_PARTICIPANT = "ScoreAsParticipant";

/**
 * Encode `Some(ScoreAsParticipantData { nonce })` for the extension's declared
 * type.
 *
 * The chain's `ScoreAsParticipant` is a newtype over
 * `Option<ScoreAsParticipantData>`, and `ScoreAsParticipantData` is a newtype
 * over the nonce, so PAPI's dynamic codec unwraps both and takes the bare
 * number. Handing it `{ nonce }` instead silently encodes `Some(0)` — measured,
 * and exactly the class of mistake the round trip in `encodeChecked` turns into
 * a thrown `AsPersonError`.
 */
function encodeScoreAsParticipant(pipeline: ExtensionPipeline, nonce: number): Uint8Array {
    return encodeChecked(pipeline.codec(pipeline.slot(SCORE_AS_PARTICIPANT).type), nonce);
}

/**
 * Wrap a signer so its transactions run as the score participant, fee-free.
 *
 * `signBytes` and `publicKey` pass through untouched. PAPI stamps `publicKey`
 * into the extrinsic and uses it to fetch the nonce, so it has to stay the
 * inner signer's — which is also what keeps the participant the chain resolves
 * (`Participants[Account(signer)]`) the account this signer signs as.
 *
 * @param signer - the signer to wrap, e.g. from
 *   `AccountsProvider.getProductAccountSigner`.
 * @returns a `PolkadotSigner` usable anywhere the original was.
 */
export function withScoreParticipant(signer: PolkadotSigner): PolkadotSigner {
    const pipelineFor = cachedPipelineReader();

    return {
        publicKey: signer.publicKey,
        signBytes: (data) => signer.signBytes(data),
        async signTx(callData, signedExtensions, metadata, atBlockNumber, hasher) {
            const pipeline = pipelineFor(metadata);
            let extensions = signedExtensions;

            // False is an immediate rejection for a restricted origin, and false
            // is PAPI's default. Skipped only when the chain has no such extension.
            if (pipeline.extensions.some((slot) => slot.identifier === RESTRICT_ORIGINS)) {
                extensions = withSlot(
                    pipeline,
                    extensions,
                    RESTRICT_ORIGINS,
                    encodeChecked(pipeline.codec(pipeline.slot(RESTRICT_ORIGINS).type), true),
                );
            }

            extensions = withSlot(
                pipeline,
                extensions,
                SCORE_AS_PARTICIPANT,
                encodeScoreAsParticipant(pipeline, nonceFrom(pipeline, extensions)),
            );

            return signer.signTx(callData, extensions, metadata, atBlockNumber, hasher);
        },
    };
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { readExtensionPipeline } = await import("./as-person-codec.js");
    const { CHECK_NONCE, VERIFY_SIGNATURE } = await import("./origin-extension.js");
    const { AsPersonError } = await import("./errors.js");
    type PapiSignedExtensions = import("./as-person-implication.js").PapiSignedExtensions;

    /** Local hex formatter, deliberately not the one the code under test uses. */
    const hex = (bytes: Uint8Array) =>
        `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

    const blob = (name: string) =>
        new Uint8Array(
            readFileSync(
                new URL(`../../descriptors/.papi/metadata/${name}.scale`, import.meta.url),
            ),
        );

    const METADATA = blob("paseo_individuality");
    const PIPELINE = readExtensionPipeline(METADATA);

    const PUBLIC_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const CALL_DATA = Uint8Array.from([0x33, 0x01, 0xaa]);

    /** Every declared slot except VerifyMultiSignature, as PAPI hands the map over. */
    function papiExtensions(nonce = 7): PapiSignedExtensions {
        const nonceBytes = PIPELINE.codec(PIPELINE.slot(CHECK_NONCE).type)[0](nonce);
        return Object.fromEntries(
            PIPELINE.extensions
                .filter((slot) => slot.identifier !== VERIFY_SIGNATURE)
                .map((slot, index) => [
                    slot.identifier,
                    {
                        identifier: slot.identifier,
                        value:
                            slot.identifier === CHECK_NONCE ? nonceBytes : Uint8Array.from([index]),
                        additionalSigned: Uint8Array.from([100 + index]),
                    },
                ]),
        ) as PapiSignedExtensions;
    }

    /** An inner signer that records exactly what it was handed. */
    function spySigner() {
        const calls: {
            callData: Uint8Array;
            extensions: PapiSignedExtensions;
            atBlockNumber: number;
            hasher?: (data: Uint8Array) => Uint8Array;
        }[] = [];
        const signer: PolkadotSigner = {
            publicKey: PUBLIC_KEY,
            signBytes: vi.fn(async () => Uint8Array.from([0xff])),
            signTx: async (callData, extensions, _metadata, atBlockNumber, hasher) => {
                calls.push({ callData, extensions, atBlockNumber, hasher });
                return Uint8Array.from([0xde, 0xad]);
            },
        };
        return { signer, calls };
    }

    const sign = async (extensions = papiExtensions()) => {
        const { signer, calls } = spySigner();
        const result = await withScoreParticipant(signer).signTx(
            CALL_DATA,
            extensions,
            METADATA,
            123,
        );
        return { result, calls, seen: calls[0].extensions };
    };

    describe("the pipeline slot", () => {
        test("every individuality chain declares ScoreAsParticipant at index 4", () => {
            for (const name of [
                "paseo_individuality",
                "previewnet_individuality",
                "devnet_individuality",
            ]) {
                expect(readExtensionPipeline(blob(name)).indexOf("ScoreAsParticipant")).toBe(4);
            }
        });
    });

    describe("withScoreParticipant", () => {
        test("encodes Some(nonce) from the nonce PAPI already put in CheckNonce", async () => {
            // Some, then 7 as a plain u32: the newtype and the data struct both
            // unwrap. Taking the nonce from the slot PAPI filled is what makes
            // the two impossible to disagree — the chain checks them against
            // each other.
            const { seen } = await sign(papiExtensions(7));
            expect(hex(seen.ScoreAsParticipant.value)).toBe("0x0107000000");
        });

        test("tracks the nonce rather than assuming one", async () => {
            const { seen } = await sign(papiExtensions(300));
            expect(hex(seen.ScoreAsParticipant.value)).toBe("0x012c010000");
        });

        test("previewnet agrees on the encoding", async () => {
            // Previewnet is the chain the registration flow was verified on, so
            // its blob is pinned alongside the descriptor chain's.
            const previewnet = readExtensionPipeline(blob("previewnet_individuality"));
            const encode = (pipeline: ExtensionPipeline) =>
                encodeChecked(pipeline.codec(pipeline.slot("ScoreAsParticipant").type), 7);
            expect(hex(encode(previewnet))).toBe(hex(encode(PIPELINE)));
        });

        test("sets RestrictOrigins to true", async () => {
            // The participant origin is a restricted entity, and PAPI's default
            // of false is an immediate rejection for it.
            const { seen } = await sign();
            expect(hex(seen.RestrictOrigins.value)).toBe("0x01");
        });

        test("leaves VerifyMultiSignature absent so the host signs", async () => {
            // The extension requires the Signed origin underneath, and PAPI's
            // default — omit the slot entirely — is what produces it.
            const { seen } = await sign();
            expect(VERIFY_SIGNATURE in seen).toBe(false);
        });

        test("keeps the map in the order the chain declares", async () => {
            const { seen } = await sign();
            const declared = PIPELINE.extensions
                .map((slot) => slot.identifier)
                .filter((identifier) => identifier in seen);
            expect(Object.keys(seen)).toEqual(declared);
        });

        test("throws when CheckNonce is missing, and does not sign", async () => {
            const extensions = Object.fromEntries(
                Object.entries(papiExtensions()).filter(([key]) => key !== CHECK_NONCE),
            ) as PapiSignedExtensions;
            const { signer, calls } = spySigner();
            await expect(
                withScoreParticipant(signer).signTx(CALL_DATA, extensions, METADATA, 1),
            ).rejects.toThrow(AsPersonError);
            expect(calls).toHaveLength(0);
        });

        test("passes callData, block number and hasher through untouched", async () => {
            const { signer, calls } = spySigner();
            const hasher = (data: Uint8Array) => data;
            await withScoreParticipant(signer).signTx(
                CALL_DATA,
                papiExtensions(),
                METADATA,
                456,
                hasher,
            );
            expect(calls[0].callData).toBe(CALL_DATA);
            expect(calls[0].atBlockNumber).toBe(456);
            expect(calls[0].hasher).toBe(hasher);
        });

        test("returns whatever the inner signer returned", async () => {
            const { result } = await sign();
            expect(hex(result)).toBe("0xdead");
        });

        test("passes publicKey and signBytes straight through", async () => {
            const { signer } = spySigner();
            const wrapped = withScoreParticipant(signer);
            expect(wrapped.publicKey).toBe(signer.publicKey);
            expect(hex(await wrapped.signBytes(Uint8Array.from([1])))).toBe("0xff");
            expect(signer.signBytes).toHaveBeenCalledOnce();
        });

        test("throws for a chain that does not declare ScoreAsParticipant", async () => {
            const { signer, calls } = spySigner();
            await expect(
                withScoreParticipant(signer).signTx(
                    CALL_DATA,
                    papiExtensions(),
                    blob("paseo_asset_hub"),
                    1,
                ),
            ).rejects.toThrow(AsPersonError);
            expect(calls).toHaveLength(0);
        });
    });
}
