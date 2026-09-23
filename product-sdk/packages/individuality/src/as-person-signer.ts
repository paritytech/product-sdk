// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `withAsPerson`: run a call under a person origin instead of an account origin.
 *
 * This wraps a signer rather than the submitter, and that is the whole design.
 * The `AsPerson` value cannot be chosen at the call site, because it depends on
 * the nonce and, for the proof variants, on a hash over every other extension in
 * the pipeline. PAPI resolves nonce, mortality, tip, genesis and the runtime
 * versions inside its own `createTx` and only then calls
 * `PolkadotSigner.signTx`. That call is the one place where those values exist
 * and are still patchable, so it is where this belongs.
 *
 * The consequence worth knowing: nothing in `@parity/product-sdk-tx` changes.
 * A decorated signer composes with `submitAndWatch`, `batchSubmitAndWatch`, fee
 * estimation and plain `signSubmitAndWatch` for free.
 *
 * ```ts
 * import { submitAndWatch } from "@parity/product-sdk-tx";
 * import { withAsPerson } from "@parity/product-sdk-individuality";
 *
 * const signer = withAsPerson(accounts.getProductAccountSigner(account), {
 *     tag: "AliasWithAccount",
 * });
 * await submitAndWatch(
 *     api.tx.Game.sign_up_with_alias({ identifier_key, statement_account, sig }),
 *     signer,
 * );
 * ```
 *
 * The origin works, the call does not: `sig`, the statement-account proof, is a
 * bare `blake2_256` hash and the host's `signRaw` always `<Bytes>`-wraps it.
 *
 * The order inside `signTx` is `withOriginExtension`'s, in
 * `origin-extension.ts`. Getting it wrong produces a bad proof with nothing
 * local to read, which is why it lives in one place.
 */
import type { PolkadotSigner } from "polkadot-api";

import {
    AS_PERSON,
    type AsPersonValue,
    type ExtensionPipeline,
    encodeAsPersonInfo,
    encodeChecked,
    readExtensionPipeline,
} from "./as-person-codec.js";
import {
    type PapiSignedExtensions,
    buildImplication,
    implicationMessage,
    reviseMessage,
} from "./as-person-implication.js";
import { AsPersonError } from "./errors.js";
import {
    CHECK_NONCE,
    RESTRICT_ORIGINS,
    VERIFY_SIGNATURE,
    cachedPipelineReader,
    nonceFrom,
    requestProof,
    type CreateRingVRFProof,
    type RingVRFProof,
    withOriginExtension,
    withSlot,
} from "./origin-extension.js";

// Re-exported from the shared plumbing, so the types stay importable from where
// consumers found them before `withLiteAlias` moved them to `origin-extension.ts`.
export type { CreateRingVRFProof, RingVRFProof } from "./origin-extension.js";

/**
 * Which person origin the transaction should run under.
 *
 * Only the alias variants are here. `AsPersonalIdentityWithProof` needs a raw
 * sr25519 signature over the implication hash, which no host call currently
 * produces, and `AsPersonalIdentityWithAccount` has no known consumer.
 */
export type AsPersonInfo =
    /**
     * Signed by an account already bound to the alias, via
     * `People.set_alias_account`. Needs no proof.
     *
     * The chain reads `People.AccountToAlias` for the signing account and
     * requires the stored ring revision to be current. When it is not, the chain
     * answers `BadSigner` and {@link AsPersonInfo} `AliasWithAccountRevised` is
     * the variant that fixes it. That cannot be detected from here without
     * reading the ring root.
     */
    | { tag: "AliasWithAccount" }
    /**
     * No signature: a general transaction with a `None` origin, authorized by the
     * proof alone.
     *
     * The chain accepts this for `People.set_alias_account` and nothing else, and
     * requires the proof's context to be one the runtime allows accounts to be
     * bound in. Individuality up to v0.11.2, which is what paseo runs today,
     * fixes those as constants that no host-minted context can equal, so the call
     * is rejected there however correct the bytes are. v0.12.0 derives them with
     * the same product-scoped construction the host uses, which makes this
     * variant reachable once paseo upgrades. Nothing here changes when it does.
     */
    | { tag: "AliasWithProof"; createProof: CreateRingVRFProof }
    /**
     * Signed, and moves the stored alias to the ring revision in force now.
     *
     * The proof must be over the same context the alias was originally bound in.
     */
    | { tag: "AliasWithAccountRevised"; createProof: CreateRingVRFProof };

/**
 * Build the `AsPerson` value for `info`, requesting a proof when the variant
 * needs one.
 *
 * Called after every other slot holds its final value, because two of the three
 * variants hash them.
 */
async function buildValue(
    pipeline: ExtensionPipeline,
    callData: Uint8Array,
    extensions: PapiSignedExtensions,
    info: AsPersonInfo,
    aliasAccount: Uint8Array,
): Promise<AsPersonValue> {
    switch (info.tag) {
        case "AliasWithAccount":
            return {
                tag: "AsPersonalAliasWithAccount",
                nonce: nonceFrom(pipeline, extensions),
            };

        case "AliasWithProof": {
            const proof = await requestProof(
                info.createProof,
                implicationMessage(pipeline, callData, extensions, AS_PERSON),
            );
            return {
                tag: "AsPersonalAliasWithProof",
                proof: proof.proof,
                ringIndex: proof.ringIndex,
                revision: proof.ringRevision,
                context: proof.contextualAlias.context,
            };
        }

        case "AliasWithAccountRevised": {
            const nonce = nonceFrom(pipeline, extensions);
            // This variant binds the implication plus a label, the alias account
            // and the nonce, so it needs the implication bytes rather than the
            // plain message.
            const implication = buildImplication(pipeline, callData, extensions, AS_PERSON);
            const proof = await requestProof(
                info.createProof,
                reviseMessage(implication, aliasAccount, nonce),
            );
            return {
                tag: "AsPersonalAliasWithAccountRevised",
                nonce,
                proof: proof.proof,
                ringIndex: proof.ringIndex,
                revision: proof.ringRevision,
                context: proof.contextualAlias.context,
            };
        }

        default:
            // Unreachable through the typed union, reachable from JavaScript. The
            // switch returning `undefined` would encode the extension as `None`,
            // which runs the call under a plain account origin: a transaction that
            // can succeed while doing the wrong thing.
            throw new AsPersonError("unknown AsPerson variant");
    }
}

/**
 * Wrap a signer so its transactions run under a person origin.
 *
 * `signBytes` and `publicKey` pass through untouched. PAPI stamps `publicKey`
 * into the extrinsic and uses it to fetch the nonce, so it has to stay the inner
 * signer's.
 *
 * @param signer - the signer to wrap, e.g. from
 *   `AccountsProvider.getProductAccountSigner`.
 * @param info - which person origin to use, and where the proof comes from.
 * @returns a `PolkadotSigner` usable anywhere the original was.
 */
export function withAsPerson(signer: PolkadotSigner, info: AsPersonInfo): PolkadotSigner {
    return withOriginExtension<AsPersonValue>(signer, {
        identifier: AS_PERSON,
        unsigned: info.tag === "AliasWithProof",
        encode: encodeAsPersonInfo,
        buildValue: (pipeline, callData, extensions, aliasAccount) =>
            buildValue(pipeline, callData, extensions, info, aliasAccount),
    });
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");

    /**
     * Local hex formatter, deliberately not the one the code under test uses.
     * Sharing a formatter with the implementation would hide a bug in it, and it
     * keeps this package's fast test loop off a sibling workspace package.
     */
    const hex = (bytes: Uint8Array) =>
        `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

    const METADATA = new Uint8Array(
        readFileSync(
            new URL("../../descriptors/.papi/metadata/paseo_individuality.scale", import.meta.url),
        ),
    );
    const PIPELINE = readExtensionPipeline(METADATA);

    const PUBLIC_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const CALL_DATA = Uint8Array.from([0x33, 0x01, 0xaa]);
    const PROOF_BYTES = Uint8Array.from([0xaa, 0xbb, 0xcc]);
    const CONTEXT = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);

    const RING_PROOF: RingVRFProof = {
        proof: PROOF_BYTES,
        contextualAlias: { context: CONTEXT, alias: new Uint8Array(32) },
        ringIndex: 4,
        ringRevision: 5,
    };

    /**
     * The map PAPI hands to `signTx`: every declared slot except
     * `VerifyMultiSignature`, which PAPI drops whenever the host is to sign.
     * Values are positional so a wrong slot is readable in a failure.
     */
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

    const sign = async (info: AsPersonInfo, extensions = papiExtensions()) => {
        const { signer, calls } = spySigner();
        const result = await withAsPerson(signer, info).signTx(
            CALL_DATA,
            extensions,
            METADATA,
            123,
        );
        return { result, calls, seen: calls[0].extensions };
    };

    describe("withAsPerson, shared behaviour", () => {
        test("sets RestrictOrigins to true", () => {
            // False is an immediate InvalidTransaction::Call for a person origin,
            // and PAPI's default is false.
            return sign({ tag: "AliasWithAccount" }).then(({ seen }) => {
                expect(hex(seen[RESTRICT_ORIGINS].value)).toBe("0x01");
            });
        });

        test("patches RestrictOrigins before hashing, so it is inside the proof", async () => {
            // The ordering claim, asserted rather than asserted-in-a-comment: the
            // message the proof covers must be the one computed over
            // RestrictOrigins = true.
            let seenMessage: Uint8Array | undefined;
            await sign({
                tag: "AliasWithProof",
                createProof: async (message) => {
                    seenMessage = message;
                    return RING_PROOF;
                },
            });

            const patched = withSlot(
                PIPELINE,
                withSlot(PIPELINE, papiExtensions(), RESTRICT_ORIGINS, Uint8Array.from([0x01])),
                VERIFY_SIGNATURE,
                Uint8Array.from([0x00]),
            );
            expect(seenMessage).toEqual(
                implicationMessage(PIPELINE, CALL_DATA, patched, AS_PERSON),
            );
        });

        test("writes AsPerson last, and its value is outside its own hash", async () => {
            let seenMessage: Uint8Array | undefined;
            const { seen } = await sign({
                tag: "AliasWithProof",
                createProof: async (message) => {
                    seenMessage = message;
                    return RING_PROOF;
                },
            });

            // AsPerson ends up holding the proof.
            expect(hex(seen[AS_PERSON].value).startsWith("0x0101")).toBe(true);

            // And re-hashing the *final* map, proof and all, reproduces the very
            // message the proof was taken over. That equality is the property the
            // whole ordering rests on: writing the proof into AsPerson cannot
            // invalidate the proof, because AsPerson is outside its own hash. If
            // this ever became an inequality the design would be circular.
            expect(seenMessage).toEqual(implicationMessage(PIPELINE, CALL_DATA, seen, AS_PERSON));
        });

        test("keeps the map in the order the chain declares", async () => {
            const { seen } = await sign({ tag: "AliasWithAccount" });
            const declared = PIPELINE.extensions
                .map((slot) => slot.identifier)
                .filter((identifier) => identifier in seen);
            expect(Object.keys(seen)).toEqual(declared);
        });

        test("passes callData, block number and hasher through untouched", async () => {
            const { signer, calls } = spySigner();
            const hasher = (data: Uint8Array) => data;
            await withAsPerson(signer, { tag: "AliasWithAccount" }).signTx(
                CALL_DATA,
                papiExtensions(),
                METADATA,
                456,
                hasher,
            );
            expect(calls[0].callData).toBe(CALL_DATA);
            expect(calls[0].atBlockNumber).toBe(456);
            // The fifth argument is optional and easy to drop when delegating.
            expect(calls[0].hasher).toBe(hasher);
        });

        test("returns whatever the inner signer returned", async () => {
            const { result } = await sign({ tag: "AliasWithAccount" });
            expect(hex(result)).toBe("0xdead");
        });

        test("passes publicKey and signBytes straight through", async () => {
            const { signer } = spySigner();
            const wrapped = withAsPerson(signer, { tag: "AliasWithAccount" });
            expect(wrapped.publicKey).toBe(signer.publicKey);
            expect(hex(await wrapped.signBytes(Uint8Array.from([1])))).toBe("0xff");
            expect(signer.signBytes).toHaveBeenCalledOnce();
        });
    });

    describe("input validation at the package boundary", () => {
        test("an unrecognized tag throws instead of silently encoding None", async () => {
            // None would run the call under a plain account origin, so it could
            // succeed while doing the wrong thing. Reachable from JavaScript,
            // including by passing the on-chain variant name by mistake.
            for (const tag of [
                "aliasWithAccount",
                "AsPersonalAliasWithAccount",
                "Typo",
                undefined,
            ]) {
                await expect(sign({ tag } as unknown as AsPersonInfo)).rejects.toThrow(
                    AsPersonError,
                );
            }
        });

        test("reads the metadata once per signer, not once per signature", async () => {
            // Decoding the blob is about 7 ms. PAPI hands the same array until the
            // runtime upgrades, so the pipeline is cached on identity.
            const { signer } = spySigner();
            const wrapped = withAsPerson(signer, { tag: "AliasWithAccount" });

            const first = process.hrtime.bigint();
            await wrapped.signTx(CALL_DATA, papiExtensions(), METADATA, 1);
            const firstMs = Number(process.hrtime.bigint() - first) / 1e6;

            const second = process.hrtime.bigint();
            await wrapped.signTx(CALL_DATA, papiExtensions(), METADATA, 2);
            const secondMs = Number(process.hrtime.bigint() - second) / 1e6;

            // Generous ratio so this is not a flaky timing test: the point is that
            // the decode is gone, not how fast the rest is.
            expect(secondMs).toBeLessThan(firstMs / 2);
        });

        test("re-reads the metadata when the runtime changes", async () => {
            // A different array means a different runtime, so the cache must miss.
            const { signer, calls } = spySigner();
            const wrapped = withAsPerson(signer, { tag: "AliasWithAccount" });
            await wrapped.signTx(CALL_DATA, papiExtensions(), METADATA, 1);
            await wrapped.signTx(CALL_DATA, papiExtensions(), new Uint8Array(METADATA), 2);
            expect(calls).toHaveLength(2);
        });
    });

    describe("AliasWithAccount", () => {
        test("encodes variant 0 with the nonce PAPI already put in CheckNonce", async () => {
            const { seen } = await sign({ tag: "AliasWithAccount" }, papiExtensions(7));
            // Some, variant 0, then 7 as a plain u32. Taking the nonce from the
            // slot PAPI filled is what makes the two impossible to disagree.
            expect(hex(seen[AS_PERSON].value)).toBe("0x010007000000");
        });

        test("tracks the nonce rather than assuming one", async () => {
            const { seen } = await sign({ tag: "AliasWithAccount" }, papiExtensions(300));
            expect(hex(seen[AS_PERSON].value)).toBe("0x01002c010000");
        });

        test("leaves VerifyMultiSignature absent so the host signs", async () => {
            // Origin has to be Signed for this variant. The host owns the slot
            // whenever it is not supplied.
            const { seen } = await sign({ tag: "AliasWithAccount" });
            expect(VERIFY_SIGNATURE in seen).toBe(false);
        });

        test("throws when CheckNonce is missing", async () => {
            const extensions = Object.fromEntries(
                Object.entries(papiExtensions()).filter(([key]) => key !== CHECK_NONCE),
            ) as PapiSignedExtensions;
            await expect(sign({ tag: "AliasWithAccount" }, extensions)).rejects.toThrow(
                AsPersonError,
            );
        });
    });

    describe("AliasWithProof", () => {
        const info = (createProof: CreateRingVRFProof = async () => RING_PROOF): AsPersonInfo => ({
            tag: "AliasWithProof",
            createProof,
        });

        test("sets VerifyMultiSignature to Disabled so the origin is None", async () => {
            // The host returns an unsigned general transaction only when the
            // caller supplies this slot. Disabled is variant 0.
            const { seen } = await sign(info());
            expect(hex(seen[VERIFY_SIGNATURE].value)).toBe("0x00");
            expect(hex(seen[VERIFY_SIGNATURE].additionalSigned)).toBe("0x");
        });

        test("encodes variant 1 from the returned proof, including the revision", async () => {
            const { seen } = await sign(info());
            expect(hex(seen[AS_PERSON].value)).toBe(
                `0x01010caabbcc0400000005000000${hex(CONTEXT).slice(2)}`,
            );
        });

        test("takes the context from the proof, not from the request", async () => {
            // Whichever call mints the proof decides the context, which is what
            // lets a future host call slot in with no change here.
            const other = Uint8Array.from({ length: 32 }, () => 0x99);
            const { seen } = await sign(
                info(async () => ({
                    ...RING_PROOF,
                    contextualAlias: { context: other, alias: new Uint8Array(32) },
                })),
            );
            expect(hex(seen[AS_PERSON].value).endsWith(hex(other).slice(2))).toBe(true);
        });

        test("calls createProof exactly once, with a 32-byte message", async () => {
            const createProof = vi.fn<CreateRingVRFProof>(async () => RING_PROOF);
            await sign(info(createProof));
            expect(createProof).toHaveBeenCalledOnce();
            expect(createProof.mock.calls[0][0]).toHaveLength(32);
        });

        test("reports a proof that resolves with the wrong shape as this package's error", async () => {
            // The likelier mistake than a rejection: callers adapt a host call
            // that returns a Result into a promise of a plain object.
            const malformed = [
                async () => undefined,
                async () => ({}),
                async () => ({ proof: PROOF_BYTES, ringIndex: 1, ringRevision: 1 }),
                async () => ({ ...RING_PROOF, ringIndex: "4" }),
            ] as unknown as CreateRingVRFProof[];

            for (const createProof of malformed) {
                await expect(sign(info(createProof))).rejects.toThrow(AsPersonError);
            }
        });

        test("does not sign when the proof shape is wrong", async () => {
            const { signer, calls } = spySigner();
            await withAsPerson(signer, {
                tag: "AliasWithProof",
                createProof: (async () => undefined) as unknown as CreateRingVRFProof,
            })
                .signTx(CALL_DATA, papiExtensions(), METADATA, 1)
                .catch(() => {});
            expect(calls).toHaveLength(0);
        });

        test("rejects an empty proof", async () => {
            await expect(
                sign(info(async () => ({ ...RING_PROOF, proof: new Uint8Array() }))),
            ).rejects.toThrow(AsPersonError);
        });

        test("rejects a proof larger than the chain accepts", async () => {
            // PAPI's byte encoder enforces no BoundedVec bound, so without this
            // the SDK builds an extrinsic the node rejects on decode.
            await expect(
                sign(info(async () => ({ ...RING_PROOF, proof: new Uint8Array(100_000) }))),
            ).rejects.toThrow(AsPersonError);
        });

        test("reports a rejected proof as this package's error", async () => {
            const boom = new Error("user declined");
            await expect(
                sign(
                    info(async () => {
                        throw boom;
                    }),
                ),
            ).rejects.toThrow(AsPersonError);
        });

        test("keeps the underlying rejection as the cause", async () => {
            const boom = new Error("host unavailable");
            await sign(
                info(async () => {
                    throw boom;
                }),
            ).then(
                () => expect.unreachable("should have thrown"),
                (error) => expect((error as Error).cause).toBe(boom),
            );
        });

        test("does not sign when the proof fails", async () => {
            const { signer, calls } = spySigner();
            await withAsPerson(signer, {
                tag: "AliasWithProof",
                createProof: async () => {
                    throw new Error("nope");
                },
            })
                .signTx(CALL_DATA, papiExtensions(), METADATA, 1)
                .catch(() => {});
            expect(calls).toHaveLength(0);
        });

        test("rejects a proof whose context is not 32 bytes", async () => {
            // Caught by the codec's round-trip guard rather than by a length
            // check here, so the metadata stays the authority on the width.
            await expect(
                sign(
                    info(async () => ({
                        ...RING_PROOF,
                        contextualAlias: {
                            context: CONTEXT.slice(0, 31),
                            alias: new Uint8Array(32),
                        },
                    })),
                ),
            ).rejects.toThrow(AsPersonError);
        });
    });

    describe("AliasWithAccountRevised", () => {
        const info = (createProof: CreateRingVRFProof = async () => RING_PROOF): AsPersonInfo => ({
            tag: "AliasWithAccountRevised",
            createProof,
        });

        test("encodes variant 4 with the nonce first", async () => {
            const { seen } = await sign(info(), papiExtensions(9));
            expect(hex(seen[AS_PERSON].value)).toBe(
                `0x0104090000000caabbcc0400000005000000${hex(CONTEXT).slice(2)}`,
            );
        });

        test("binds the revise message, not the plain implication hash", async () => {
            let seenMessage: Uint8Array | undefined;
            await sign(
                info(async (message) => {
                    seenMessage = message;
                    return RING_PROOF;
                }),
                papiExtensions(9),
            );

            const patched = withSlot(
                PIPELINE,
                papiExtensions(9),
                RESTRICT_ORIGINS,
                Uint8Array.from([0x01]),
            );
            const implication = buildImplication(PIPELINE, CALL_DATA, patched, AS_PERSON);
            expect(seenMessage).toEqual(reviseMessage(implication, PUBLIC_KEY, 9));
            // The distinction that matters: it is not the plain message.
            expect(seenMessage).not.toEqual(
                implicationMessage(PIPELINE, CALL_DATA, patched, AS_PERSON),
            );
        });

        test("uses the signer's own public key as the alias account", async () => {
            let seenMessage: Uint8Array | undefined;
            await sign(
                info(async (message) => {
                    seenMessage = message;
                    return RING_PROOF;
                }),
                papiExtensions(9),
            );
            const patched = withSlot(
                PIPELINE,
                papiExtensions(9),
                RESTRICT_ORIGINS,
                Uint8Array.from([0x01]),
            );
            const wrongAccount = Uint8Array.from({ length: 32 }, () => 0x07);
            expect(seenMessage).not.toEqual(
                reviseMessage(
                    buildImplication(PIPELINE, CALL_DATA, patched, AS_PERSON),
                    wrongAccount,
                    9,
                ),
            );
        });

        test("leaves VerifyMultiSignature absent, because the origin must be signed", async () => {
            const { seen } = await sign(info());
            expect(VERIFY_SIGNATURE in seen).toBe(false);
        });
    });
}
