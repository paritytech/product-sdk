// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The bind leg of the lite sign-up, encoded fully client-side.
 *
 * `PeopleLite.set_alias_account(account, valid_at_block)` is the one call the
 * chain accepts under `PeopleLiteAuth::AsLiteAliasWithProof`: an unsigned V5
 * *general* extrinsic whose origin is `None`, authorized by the ring-VRF proof
 * alone. It binds the prover's lite alias to `account` — and `account` is a
 * plain call parameter, nothing ties it to whoever submits, which is what lets
 * the personhood product vouch for another product's account.
 *
 * Two paths reach this leg: `withLiteAlias({ tag: "AliasWithProof" })` has the
 * host assemble the envelope, this builder assembles it here. Prefer this one
 * unless you want the host to own it, because per-host `createTransaction`
 * dialects have diverged before.
 *
 * A general transaction is
 *
 * ```
 * compact(len) ++ preamble(0x45) ++ u8(extensionVersion) ++ extras ++ call
 * ```
 *
 * — no address, no signature, no signed envelope — so with the extension
 * pipeline read from the chain's own metadata the whole thing is encodable
 * here: every slot's *extra* takes the value a general transaction needs (the
 * table below), the proof message is blake2-256 of the implication after
 * `PeopleLiteAuth`, and the proof is written into a slot that hash never
 * covered. The layout ran live on previewnet (spec 1000036, individuality
 * v0.12.1) as the first of the two lite sign-up transactions; dim2's hand
 * encoder there is the reference this reproduces without a host round trip.
 *
 * The defaults are load-bearing, each verified the expensive way:
 *
 * - `RestrictOrigins` is `true`. A lite alias pays no fee, so
 *   pallet-origin-restriction meters it against an allowance instead — and
 *   rejects a restricted origin outright when the slot says `false`.
 * - `VerifyMultiSignature` is `Disabled`. In a general transaction that slot is
 *   the only place a signature could live; `Disabled` is what makes the origin
 *   `None` for `PeopleLiteAuth` to transmute.
 * - `CheckMortality` is immortal, so its implicit is the genesis hash and no
 *   recent block hash has to be fetched. The call's own `valid_at_block` bounds
 *   how long the transaction is worth anything (the chain holds it to a
 *   tolerance window measured from the current block).
 * - `CheckNonce` is `0`. By the time it runs the origin is `LiteAlias`, not a
 *   signed account, and the nonce check is a pass-through — the extras must
 *   still carry a value, and the node must recompute the same bytes.
 * - Every origin-modifying `Option` slot is `None`, and the unit slots are
 *   empty, exactly as PAPI would fill them.
 *
 * **Replay is bounded only by the binding itself.** The call carries no nonce;
 * two bind transactions alive at once (within the ~600-block
 * `valid_at_block` tolerance) can be replayed against each other. Never build
 * a second one while the first may still be in flight, and skip the leg
 * entirely when `PeopleLite.AccountToAlias` already holds the binding — a
 * re-bind is rejected as stale, not deduplicated.
 *
 * **Check the context first.** The chain accepts the proof only in a context
 * it allows accounts to be bound in — `Score.score_context`. Run
 * `readScoreContext` before wiring `createProof`, and stop on
 * `NotProductDerived`: a host can only mint product-derived contexts, so on
 * such a runtime (nextv2 today) the chain would reject the transaction as
 * `InvalidTransaction::Call` with nothing local to read.
 *
 * ```ts
 * const score = await readScoreContext(chain);
 * if (!score.ok || score.value.tag !== "ProductDerived") return;
 *
 * // Skip the leg when PeopleLite.AccountToAlias already holds the binding.
 * const { transaction } = await buildLiteAliasBindTx(chain, {
 *     account,
 *     createProof: (message) =>
 *         accounts.createRingVRFProof(
 *             liteKeyHandle,
 *             { productId: score.value.productId, suffix: { tag: "Index", value: 0 } },
 *             litePeopleRing(genesisHash),
 *             message,
 *         ),
 * });
 * await client.submit(`0x${bytesToHex(transaction)}`);
 * ```
 *
 * Submission stays with the caller's client — the result is the finished
 * extrinsic, so any raw submit works and no signer is involved.
 */
import { AccountId } from "polkadot-api";
import { concatBytes } from "@parity/product-sdk-utils";
import { compactNumber } from "@polkadot-api/substrate-bindings";

import { PEOPLE_LITE_AUTH, encodePeopleLiteAuthInfo } from "./as-lite-alias-codec.js";
import { type ExtensionPipeline, encodeChecked, readExtensionPipeline } from "./as-person-codec.js";
import { type PapiSignedExtensions, implicationMessage } from "./as-person-implication.js";
import { AsPersonError, ProductIndividualityError } from "./errors.js";
import {
    CHECK_NONCE,
    type CreateRingVRFProof,
    RESTRICT_ORIGINS,
    RESTRICT_ORIGINS_ENABLED,
    VERIFY_SIGNATURE,
    VERIFY_SIGNATURE_DISABLED,
    requestProof,
    withSlot,
} from "./origin-extension.js";
import type { ReadAt } from "./pinned.js";

/** The V5 preamble byte: extrinsic format 5, general transaction (`0b01` origin bits). */
const V5_GENERAL_PREAMBLE = 0b0100_0000 | 5;

/** Metadata versions worth asking for, newest first. Both carry the pipeline. */
const METADATA_VERSIONS = [16, 15];

/** 32 bytes of `0x` hex — the genesis hash as PAPI's chain-spec data spells it. */
const GENESIS_HEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * The value each extension's extra carries in this general transaction, by
 * identifier. Slots not named here encode `undefined` — `None` for an `Option`,
 * nothing for a unit — which is PAPI's own default for them. A slot that can
 * encode neither its table entry nor `undefined` is a chain this table does not
 * know, reported as a loud error naming the slot rather than a guessed byte.
 */
const GENERAL_TX_EXTRAS: Record<string, unknown> = {
    [VERIFY_SIGNATURE]: VERIFY_SIGNATURE_DISABLED,
    [RESTRICT_ORIGINS]: RESTRICT_ORIGINS_ENABLED,
    /** Immortal, so the mortality implicit is the genesis hash. */
    CheckMortality: { type: "Immortal", value: undefined },
    /** Pass-through for a non-account origin, but the bytes must be there. */
    [CHECK_NONCE]: 0,
    /** No tip, no alternate fee asset — nothing pays here. */
    ChargeAssetTxPayment: { tip: 0n, asset_id: undefined },
    /** Devnet-only slot; `Disabled` is the mode PAPI sends unprompted. */
    CheckMetadataHash: { type: "Disabled", value: undefined },
};

/** The one call-encoding method the builder needs; PAPI transactions have it. */
export interface EncodedCallSource {
    getEncodedData(): Promise<Uint8Array>;
}

/**
 * What building the bind leg needs from a chain: the call codec, the current
 * best block for `valid_at_block`, and the three values the proof implicitly
 * signs — metadata (the extension pipeline), the runtime version and the
 * genesis hash. Matched by hand against the previewnet descriptors on
 * 2026-08-31.
 */
export interface LiteAliasBindChain<Tx extends EncodedCallSource = EncodedCallSource> {
    individuality: {
        constants: {
            System: {
                /** `spec_version` and `transaction_version` are implicitly signed. */
                Version(): Promise<{ spec_version: number; transaction_version: number }>;
            };
        };
        query: {
            System: {
                /** The current block number; the call's `valid_at_block`. */
                Number: { getValue(options: ReadAt): Promise<number> };
            };
        };
        apis: {
            Metadata: {
                /** The blob the extension pipeline is read from. */
                metadata_at_version(version: number): Promise<Uint8Array | undefined>;
            };
        };
        tx: {
            PeopleLite: {
                set_alias_account(args: { account: string; valid_at_block: number }): Tx;
            };
        };
    };
    raw: {
        individuality: {
            /** Where PAPI keeps the genesis hash, implicitly signed twice. */
            getChainSpecData(): Promise<{ genesisHash: string }>;
        };
    };
}

/** Options for {@link buildLiteAliasBindTx}. */
export interface BuildLiteAliasBindTxOptions {
    /**
     * The account to bind, as an SS58 address. A plain call parameter: the
     * chain ties it to nothing but the proof's alias, which is what lets the
     * personhood product bind another product's account. `LiteInvites` later
     * pins it as the one account this lite person may ever invite, so show a
     * person *which* account they are binding before building this.
     */
    account: string;
    /**
     * Mints the lite ring-VRF proof over the message this builder computes.
     * Wire it to `createRingVRFProof` with the lite key handle, the
     * `RingLocation` from `litePeopleRing`, and the `ProductProofContext` that
     * `readScoreContext` reported — never choose the message yourself.
     */
    createProof: CreateRingVRFProof;
    signal?: AbortSignal;
}

/** What {@link buildLiteAliasBindTx} returns. */
export interface LiteAliasBindTx {
    /**
     * The finished extrinsic. Submit it raw — `client.submit`, or anything
     * that broadcasts bytes; there is nothing left to sign.
     */
    transaction: Uint8Array;
    /** The `valid_at_block` the call carries: the best block at build time. */
    validAtBlock: number;
    /** Which ring the proof was minted against, for logging. */
    ringIndex: number;
    /** That ring's revision at minting time, for logging. */
    ringRevision: number;
}

/** The newest metadata blob the chain will serve, tried newest-first. */
async function chainMetadata(
    chain: LiteAliasBindChain,
    signal: AbortSignal | undefined,
): Promise<Uint8Array> {
    for (const version of METADATA_VERSIONS) {
        signal?.throwIfAborted();
        const blob = await chain.individuality.apis.Metadata.metadata_at_version(version);
        if (blob !== undefined) {
            return blob;
        }
    }
    throw new ProductIndividualityError(
        `chain serves none of the metadata versions this package reads (${METADATA_VERSIONS.join(", ")})`,
    );
}

/** Encode one slot's half, naming the slot when the value cannot encode. */
function encodeSlot(
    pipeline: ExtensionPipeline,
    identifier: string,
    typeId: number,
    value: unknown,
): Uint8Array {
    try {
        return encodeChecked(pipeline.codec(typeId), value);
    } catch (cause) {
        // The identifier is protocol metadata, safe to name; the value is a
        // fixed default from the table above, never chain data about a person.
        throw new AsPersonError(
            `no known general-transaction encoding for the ${identifier} extension`,
            { cause },
        );
    }
}

/**
 * Every declared slot holding its general-transaction value, plus the implicit
 * the node will recompute — spec version, transaction version and (twice, via
 * `CheckGenesis` and the immortal `CheckMortality`) the genesis hash. The
 * implicits never travel, but the proof message hashes the ones after
 * `PeopleLiteAuth`, so they must match the chain's own or the proof dies as
 * a bad proof with nothing local to read.
 */
function generalTxExtensions(
    pipeline: ExtensionPipeline,
    runtime: { spec_version: number; transaction_version: number },
    genesisHash: string,
): PapiSignedExtensions {
    const implicits: Record<string, unknown> = {
        CheckSpecVersion: runtime.spec_version,
        CheckTxVersion: runtime.transaction_version,
        CheckGenesis: genesisHash,
        CheckMortality: genesisHash,
    };
    return Object.fromEntries(
        pipeline.extensions.map((slot) => [
            slot.identifier,
            {
                identifier: slot.identifier,
                value: encodeSlot(
                    pipeline,
                    slot.identifier,
                    slot.type,
                    GENERAL_TX_EXTRAS[slot.identifier],
                ),
                additionalSigned: encodeSlot(
                    pipeline,
                    slot.identifier,
                    slot.implicit,
                    implicits[slot.identifier],
                ),
            },
        ]),
    ) as PapiSignedExtensions;
}

/**
 * Build the unsigned V5 general extrinsic that binds a lite person's alias to
 * `account`: `PeopleLite.set_alias_account(account, valid_at_block)` under
 * `PeopleLiteAuth::AsLiteAliasWithProof`, encoded entirely client-side — no
 * host `createTransaction`, no signer.
 *
 * `valid_at_block` is the chain's current best block; the chain accepts the
 * call for its setup tolerance window (~600 blocks) after that. The proof is
 * requested over the implication message this builder computes, and its
 * context travels inside the proof — whichever call mints it decides, which
 * for the lite ring must be the chain's `Score.score_context` (see the module
 * doc for the read that checks this *before* any of this work is done).
 *
 * @returns the finished extrinsic bytes and the proof's ring coordinates.
 * @throws {AsPersonError} when the chain's metadata declares a pipeline or a
 *   `PeopleLiteAuth` field list this package cannot encode (devnet predates
 *   the revision field), when a slot has no known general-transaction value,
 *   or when the proof request fails or resolves malformed.
 * @throws {ProductIndividualityError} when `account` is not a valid address,
 *   or the chain serves no readable metadata or a malformed genesis hash.
 */
export async function buildLiteAliasBindTx(
    chain: LiteAliasBindChain,
    options: BuildLiteAliasBindTxOptions,
): Promise<LiteAliasBindTx> {
    const { account, createProof, signal } = options;
    signal?.throwIfAborted();
    try {
        AccountId().enc(account);
    } catch (cause) {
        throw new ProductIndividualityError("bind account is not a valid address", { cause });
    }

    const [metadata, runtime, spec, validAtBlock] = await Promise.all([
        chainMetadata(chain, signal),
        chain.individuality.constants.System.Version(),
        chain.raw.individuality.getChainSpecData(),
        // set_alias_account rejects a valid_at_block ahead of the chain.
        chain.individuality.query.System.Number.getValue({ at: "finalized", signal }),
    ]);
    if (!GENESIS_HEX.test(spec.genesisHash)) {
        throw new ProductIndividualityError("chain-spec genesis hash is not 32 bytes of hex");
    }
    signal?.throwIfAborted();

    const callData = await chain.individuality.tx.PeopleLite.set_alias_account({
        account,
        valid_at_block: validAtBlock,
    }).getEncodedData();

    const pipeline = readExtensionPipeline(metadata);
    // All three pinned blobs declare [4,5], checked 2026-09-03.
    if (!pipeline.supportedVersions.includes(5)) {
        throw new AsPersonError("chain does not accept version 5 extrinsics");
    }
    const defaults = generalTxExtensions(pipeline, runtime, spec.genesisHash);

    // PeopleLiteAuth's own slot is outside its own hash, so its default (None)
    // needs no patching before the message is computed.
    const message = implicationMessage(pipeline, callData, defaults, PEOPLE_LITE_AUTH);
    const proof = await requestProof(createProof, message);
    signal?.throwIfAborted();

    const extensions = withSlot(
        pipeline,
        defaults,
        PEOPLE_LITE_AUTH,
        encodePeopleLiteAuthInfo(pipeline, {
            tag: "AsLiteAliasWithProof",
            proof: proof.proof,
            ringIndex: proof.ringIndex,
            revision: proof.ringRevision,
            // From the proof, not from any request parameter: whichever call
            // minted it decided the context, and the chain checks the proof
            // against the context the extension carries.
            context: proof.contextualAlias.context,
        }),
    );

    const body = concatBytes(
        Uint8Array.of(V5_GENERAL_PREAMBLE, pipeline.version),
        ...pipeline.extensions.map((slot) => extensions[slot.identifier].value),
        callData,
    );
    return {
        transaction: concatBytes(compactNumber.enc(body.length), body),
        validAtBlock,
        ringIndex: proof.ringIndex,
        ringRevision: proof.ringRevision,
    };
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { blake2b256 } = await import("@parity/product-sdk-utils");

    /** Local hex helpers, deliberately not the ones the code under test uses. */
    const hex = (bytes: Uint8Array) =>
        `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const bytes = (hexString: string) =>
        Uint8Array.from(hexString.replace(/^0x/, "").match(/../g) ?? [], (pair) =>
            Number.parseInt(pair, 16),
        );
    const u32le = (value: number) => {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, value, true);
        return out;
    };

    const blob = (name: string) =>
        new Uint8Array(
            readFileSync(
                new URL(`../../descriptors/.papi/metadata/${name}.scale`, import.meta.url),
            ),
        );
    // The chain the two-transaction lite flow ran live on (spec 1000036).
    const PREVIEWNET = blob("previewnet_individuality");
    const PASEO = blob("paseo_individuality");
    // Predates the RevisionIndex field on the proof variants: a real negative.
    const DEVNET = blob("devnet_individuality");

    const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const VALID_AT = 123456;
    const SPEC_VERSION = 1000036;
    const TX_VERSION = 1;
    const GENESIS = `0x${"cd".repeat(32)}`;
    /** Marker bytes standing in for the encoded `set_alias_account` call. */
    const CALL_DATA = Uint8Array.from([0x33, 0x02, 0xaa]);
    const PROOF_BYTES = Uint8Array.from([0xaa, 0xbb, 0xcc]);
    /** 32 distinct non-zero bytes, so a truncated or zeroed context is obvious. */
    const CONTEXT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const CONTEXT_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    const RING_PROOF = {
        proof: PROOF_BYTES,
        contextualAlias: { context: CONTEXT, alias: new Uint8Array(32) },
        ringIndex: 4,
        ringRevision: 5,
    };

    function fakeChain(
        metadata: Uint8Array = PREVIEWNET,
        overrides: {
            servedVersions?: number[];
            genesisHash?: string;
        } = {},
    ) {
        const served = overrides.servedVersions ?? [16, 15];
        const txCalls: { account: string; valid_at_block: number }[] = [];
        const metadataRequests: number[] = [];
        const numberAt: unknown[] = [];
        let numberReads = 0;
        const chain: LiteAliasBindChain = {
            individuality: {
                constants: {
                    System: {
                        Version: async () => ({
                            spec_version: SPEC_VERSION,
                            transaction_version: TX_VERSION,
                        }),
                    },
                },
                query: {
                    System: {
                        Number: {
                            getValue: async (options) => {
                                numberReads += 1;
                                numberAt.push(options.at);
                                return VALID_AT;
                            },
                        },
                    },
                },
                apis: {
                    Metadata: {
                        metadata_at_version: async (version) => {
                            metadataRequests.push(version);
                            return served.includes(version) ? metadata : undefined;
                        },
                    },
                },
                tx: {
                    PeopleLite: {
                        set_alias_account: (args) => {
                            txCalls.push(args);
                            return { getEncodedData: async () => CALL_DATA };
                        },
                    },
                },
            },
            raw: {
                individuality: {
                    getChainSpecData: async () => ({
                        genesisHash: overrides.genesisHash ?? GENESIS,
                    }),
                },
            },
        };
        return { chain, txCalls, metadataRequests, numberAt, numberReads: () => numberReads };
    }

    const build = (
        chain: LiteAliasBindChain,
        createProof: CreateRingVRFProof = async () => RING_PROOF,
        signal?: AbortSignal,
    ) => buildLiteAliasBindTx(chain, { account: ACCOUNT, createProof, signal });

    /**
     * The whole extrinsic, hand-derived rather than recomputed, so the layout
     * is pinned and an encoder change is a readable diff. Previewnet declares
     * 22 extensions; each line is one slot's extra in declared order.
     */
    const EXPECTED_EXTRAS = [
        "", // UnitTransactionExtension: unit
        "00", // VerifyMultiSignature: Disabled — the origin stays None
        "00", // AsPerson: None
        "00", // AsProofOfInkParticipant: None
        "00", // ScoreAsParticipant: None
        "00", // GameAsInvited: None
        `01020caabbcc0400000005000000${CONTEXT_HEX}`, // PeopleLiteAuth: Some(AsLiteAliasWithProof)
        "00", // AsMember: None
        "00", // AsCoinage: None
        "00", // AsResources: None
        "00", // HonourAuth: None
        "", // AuthorizeCall: unit on this chain
        "01", // RestrictOrigins: true — a lite alias is a restricted origin
        "", // CheckNonZeroSender: unit
        "", // CheckSpecVersion: unit (implicitly signed)
        "", // CheckTxVersion: unit (implicitly signed)
        "", // CheckGenesis: unit (implicitly signed)
        "00", // CheckMortality: immortal
        "00", // CheckNonce: compact 0, a pass-through for a LiteAlias origin
        "", // CheckWeight: unit
        "0000", // ChargeAssetTxPayment: tip 0, no fee asset
        "", // StorageWeightReclaim: unit
    ].join("");

    // preamble ++ extensionVersion ++ extras ++ call = 2 + 60 + 3 = 65 bytes,
    // and compact(65) is the two-byte mode: ((65 << 2) | 0b01) little-endian.
    const EXPECTED_EXTRINSIC = `0x05014500${EXPECTED_EXTRAS}${hex(CALL_DATA).slice(2)}`;

    describe("buildLiteAliasBindTx", () => {
        test("encodes the pinned V5 general extrinsic byte for byte", async () => {
            const { transaction } = await build(fakeChain().chain);
            expect(hex(transaction)).toBe(EXPECTED_EXTRINSIC);
        });

        test("previewnet and paseo agree on the encoding", async () => {
            // Paseo's blob is the descriptor chain's; previewnet's is the chain
            // the flow was verified on. Same pipeline, same bytes.
            const onPreviewnet = await build(fakeChain(PREVIEWNET).chain);
            const onPaseo = await build(fakeChain(PASEO).chain);
            expect(hex(onPaseo.transaction)).toBe(hex(onPreviewnet.transaction));
        });

        test("requests the proof over the implication after PeopleLiteAuth", async () => {
            // Hand-derived from the layout, not via buildImplication, so the
            // two cannot be wrong together: pipeline version, call, the extras
            // of every slot after PeopleLiteAuth, then their implicits — which
            // for a general transaction are the runtime version pair and the
            // genesis hash twice (CheckGenesis, and immortal CheckMortality).
            let seenMessage: Uint8Array | undefined;
            await build(fakeChain().chain, async (message) => {
                seenMessage = message;
                return RING_PROOF;
            });

            // AsMember..HonourAuth None, AuthorizeCall empty, RestrictOrigins
            // true, CheckMortality immortal, CheckNonce 0, tip 0 and no asset.
            const valuesAfter = bytes(`${"00000000"}01${"00"}${"00"}0000`);
            const implicitsAfter = [
                u32le(SPEC_VERSION),
                u32le(TX_VERSION),
                bytes(GENESIS),
                bytes(GENESIS),
            ];
            expect(hex(seenMessage!)).toBe(
                hex(
                    blake2b256(
                        concatBytes(Uint8Array.of(0), CALL_DATA, valuesAfter, ...implicitsAfter),
                    ),
                ),
            );
        });

        test("takes valid_at_block from the finalized block, which the pallet requires", async () => {
            const { chain, txCalls, numberAt } = fakeChain();
            const { validAtBlock } = await build(chain);
            expect(txCalls).toEqual([{ account: ACCOUNT, valid_at_block: VALID_AT }]);
            expect(validAtBlock).toBe(VALID_AT);
            expect(numberAt).toEqual(["finalized"]);
        });

        test("surfaces the proof's ring coordinates for logging", async () => {
            const result = await build(fakeChain().chain);
            expect(result.ringIndex).toBe(RING_PROOF.ringIndex);
            expect(result.ringRevision).toBe(RING_PROOF.ringRevision);
        });

        test("takes the context from the proof, not from any request input", async () => {
            // Whichever call mints the proof decides the context; for the lite
            // ring that is the chain's Score.score_context, and it travels
            // inside the proof.
            const other = Uint8Array.from({ length: 32 }, () => 0x99);
            const { transaction } = await build(fakeChain().chain, async () => ({
                ...RING_PROOF,
                contextualAlias: { context: other, alias: new Uint8Array(32) },
            }));
            expect(hex(transaction)).toContain(hex(other).slice(2));
            expect(hex(transaction)).not.toContain(CONTEXT_HEX);
        });

        test("calls createProof exactly once, with a 32-byte message", async () => {
            const createProof = vi.fn<CreateRingVRFProof>(async () => RING_PROOF);
            await build(fakeChain().chain, createProof);
            expect(createProof).toHaveBeenCalledOnce();
            expect(createProof.mock.calls[0][0]).toHaveLength(32);
        });

        test("length-prefixes correctly across the compact width boundary", async () => {
            // A realistic bandersnatch proof (788 bytes) pushes the body well
            // past the one-byte compact mode. Decoded with PAPI's own compact
            // codec, which the encoder under test shares no code with here.
            const proof = new Uint8Array(788).fill(0xab);
            const { transaction } = await build(fakeChain().chain, async () => ({
                ...RING_PROOF,
                proof,
            }));
            const [length, remainder] = [
                compactNumber.dec(transaction),
                transaction.length - compactNumber.enc(compactNumber.dec(transaction)).length,
            ];
            expect(remainder).toBe(length);
            expect(hex(transaction)).toContain(hex(proof).slice(2));
        });

        test("asks for v16 metadata before v15, and falls back", async () => {
            const preferred = fakeChain();
            await build(preferred.chain);
            expect(preferred.metadataRequests).toEqual([16]);

            const fallback = fakeChain(PREVIEWNET, { servedVersions: [15] });
            const { transaction } = await build(fallback.chain);
            expect(fallback.metadataRequests).toEqual([16, 15]);
            expect(hex(transaction)).toBe(EXPECTED_EXTRINSIC);
        });

        test("throws this package's error when no metadata version is served", async () => {
            const { chain } = fakeChain(PREVIEWNET, { servedVersions: [] });
            await expect(build(chain)).rejects.toThrow(ProductIndividualityError);
            await expect(build(chain)).rejects.toThrow(/metadata/);
        });

        test("throws this package's error for an account that does not decode", async () => {
            const { chain, metadataRequests } = fakeChain();
            const createProof = vi.fn<CreateRingVRFProof>(async () => RING_PROOF);
            await expect(
                buildLiteAliasBindTx(chain, { account: "not-an-address", createProof }),
            ).rejects.toThrow(ProductIndividualityError);
            expect(metadataRequests).toEqual([]);
            expect(createProof).not.toHaveBeenCalled();
        });

        test("throws on a malformed genesis hash before requesting a proof", async () => {
            const { chain } = fakeChain(PREVIEWNET, { genesisHash: "0xcdcd" });
            const createProof = vi.fn<CreateRingVRFProof>(async () => RING_PROOF);
            await expect(build(chain, createProof)).rejects.toThrow(ProductIndividualityError);
            expect(createProof).not.toHaveBeenCalled();
        });

        test("keeps the proof request's rejection as the cause", async () => {
            const boom = new Error("host unavailable");
            await build(fakeChain().chain, async () => {
                throw boom;
            }).then(
                () => expect.unreachable("should have thrown"),
                (error) => {
                    expect(error).toBeInstanceOf(AsPersonError);
                    expect((error as Error).cause).toBe(boom);
                },
            );
        });

        test("reports a proof that resolves with the wrong shape as this package's error", async () => {
            const malformed = [
                async () => undefined,
                async () => ({}),
                async () => ({ proof: PROOF_BYTES, ringIndex: 1, ringRevision: 1 }),
            ] as unknown as CreateRingVRFProof[];
            for (const createProof of malformed) {
                await expect(build(fakeChain().chain, createProof)).rejects.toThrow(AsPersonError);
            }
        });

        test("rejects a chain whose PeopleLiteAuth predates the revision field", async () => {
            // Devnet declares the proof variants without RevisionIndex. The
            // round trip through the chain's own codec turns that into a loud
            // error instead of a structurally plausible wrong encoding.
            await expect(build(fakeChain(DEVNET).chain)).rejects.toThrow(AsPersonError);
        });

        test("aborting while the proof is in flight throws instead of encoding", async () => {
            const { chain } = fakeChain();
            const controller = new AbortController();
            const createProof = vi.fn<CreateRingVRFProof>(async () => {
                controller.abort();
                return RING_PROOF;
            });
            await expect(build(chain, createProof, controller.signal)).rejects.toThrow();
            expect(createProof).toHaveBeenCalledOnce();
        });

        test("an aborted signal throws before any round trip", async () => {
            const { chain, numberReads, metadataRequests } = fakeChain();
            const controller = new AbortController();
            controller.abort();
            const createProof = vi.fn<CreateRingVRFProof>(async () => RING_PROOF);
            await expect(build(chain, createProof, controller.signal)).rejects.toThrow();
            expect(numberReads()).toBe(0);
            expect(metadataRequests).toEqual([]);
            expect(createProof).not.toHaveBeenCalled();
        });
    });
}
