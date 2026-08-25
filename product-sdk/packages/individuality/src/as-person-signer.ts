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
 * Order inside `signTx` is not arbitrary, and getting it wrong produces a bad
 * proof with nothing local to read:
 *
 * 1. `RestrictOrigins` to `true`. It sits after `AsPerson`, so it is inside the
 *    hash, and the origin-restriction pallet rejects the call outright when it is
 *    false against a person origin.
 * 2. For the proof variant, `VerifyMultiSignature` to `Disabled`, which tells the
 *    host to assemble an unsigned general transaction. That is what makes the
 *    origin `None`, which is the only origin that variant accepts.
 * 3. Hash the implication, which now covers the final value of every slot after
 *    `AsPerson`.
 * 4. Ask for the proof over that hash.
 * 5. Write `AsPerson` last. Its own value is outside its own hash, which is what
 *    makes steps 3 and 5 orderable at all.
 */
import type { PolkadotSigner } from "polkadot-api";

import {
    AS_PERSON,
    type AsPersonValue,
    type ExtensionPipeline,
    encodeAsPersonInfo,
    encodeChecked,
    decodeCheckNonce,
    readExtensionPipeline,
} from "./as-person-codec.js";
import {
    type PapiSignedExtensions,
    buildImplication,
    implicationMessage,
    reviseMessage,
} from "./as-person-implication.js";
import { AsPersonError } from "./errors.js";

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
 * **The message is computed here and must not be chosen by the caller.** It is
 * blake2-256 of the call implication, which depends on the nonce, the era, the
 * tip and every other extension after `AsPerson`. A proof over anything else
 * fails on chain as a bad proof.
 *
 * The context is taken from the returned proof, not from the request, so
 * whichever call mints the proof decides it.
 */
export type CreateRingVRFProof = (message: Uint8Array) => Promise<RingVRFProof>;

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

/** Metadata identifier of the extension that carries the host's signature. */
const VERIFY_SIGNATURE = "VerifyMultiSignature";

/** Metadata identifier of the origin-restriction extension. */
const RESTRICT_ORIGINS = "RestrictOrigins";

/** Metadata identifier of the nonce extension. */
const CHECK_NONCE = "CheckNonce";

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
function withSlot(
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
function nonceFrom(pipeline: ExtensionPipeline, extensions: PapiSignedExtensions): number {
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
async function requestProof(
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
                implicationMessage(pipeline, callData, extensions),
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
            const implication = buildImplication(pipeline, callData, extensions);
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
    // Decoding the metadata is the expensive part of reading the pipeline, around
    // 7 ms for a 435 KB blob, and PAPI hands the same array for every signature
    // until the runtime upgrades. Cached on identity rather than content, so a
    // runtime upgrade brings a different array and cannot be served a stale
    // pipeline. Per closure, not module level, so two wrapped signers on two
    // chains cannot share an entry.
    let cached: { metadata: Uint8Array; pipeline: ExtensionPipeline } | undefined;
    const pipelineFor = (metadata: Uint8Array): ExtensionPipeline => {
        if (cached?.metadata !== metadata) {
            cached = { metadata, pipeline: readExtensionPipeline(metadata) };
        }
        return cached.pipeline;
    };

    return {
        publicKey: signer.publicKey,
        signBytes: (data) => signer.signBytes(data),
        async signTx(callData, signedExtensions, metadata, atBlockNumber, hasher) {
            const pipeline = pipelineFor(metadata);
            let extensions = signedExtensions;

            // Step 1. Inside the hash, and false is an immediate rejection for a
            // person origin. Skipped only when the chain has no such extension.
            if (pipeline.extensions.some((slot) => slot.identifier === RESTRICT_ORIGINS)) {
                extensions = withSlot(
                    pipeline,
                    extensions,
                    RESTRICT_ORIGINS,
                    encodeChecked(pipeline.codec(pipeline.slot(RESTRICT_ORIGINS).type), true),
                );
            }

            // Step 2. Taking over the authorization slot is what makes the host
            // return an unsigned general transaction, so the origin is `None`.
            // The other two variants need a signed origin and so must leave the
            // slot alone, which is also PAPI's default: it omits it entirely.
            if (info.tag === "AliasWithProof") {
                extensions = withSlot(
                    pipeline,
                    extensions,
                    VERIFY_SIGNATURE,
                    encodeChecked(pipeline.codec(pipeline.slot(VERIFY_SIGNATURE).type), {
                        type: "Disabled",
                        value: undefined,
                    }),
                );
            }

            // Steps 3 and 4.
            const value = await buildValue(pipeline, callData, extensions, info, signer.publicKey);

            // Step 5. Last, because its own value is outside its own hash.
            extensions = withSlot(
                pipeline,
                extensions,
                AS_PERSON,
                encodeAsPersonInfo(pipeline, value),
            );

            return signer.signTx(callData, extensions, metadata, atBlockNumber, hasher);
        },
    };
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
            expect(seenMessage).toEqual(implicationMessage(PIPELINE, CALL_DATA, patched));
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
            expect(seenMessage).toEqual(implicationMessage(PIPELINE, CALL_DATA, seen));
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
            const implication = buildImplication(PIPELINE, CALL_DATA, patched);
            expect(seenMessage).toEqual(reviseMessage(implication, PUBLIC_KEY, 9));
            // The distinction that matters: it is not the plain message.
            expect(seenMessage).not.toEqual(implicationMessage(PIPELINE, CALL_DATA, patched));
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
                reviseMessage(buildImplication(PIPELINE, CALL_DATA, patched), wrongAccount, 9),
            );
        });

        test("leaves VerifyMultiSignature absent, because the origin must be signed", async () => {
            const { seen } = await sign(info());
            expect(VERIFY_SIGNATURE in seen).toBe(false);
        });
    });
}
