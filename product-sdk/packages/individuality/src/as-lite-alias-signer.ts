// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `withLiteAlias`: run a call under a lite-person origin instead of an account
 * origin.
 *
 * The sibling of `withAsPerson`, for the `PeopleLiteAuth` extension one slot
 * further down the same pipeline, and built on the same machinery: the reasons
 * this wraps a signer rather than the submitter, and the reasons the value
 * cannot be chosen at the call site, are in `as-person-signer.ts` and apply
 * here verbatim. So does the order inside `signTx`, which both signers get from
 * `withOriginExtension`. Both lite origins are restricted entities, metered
 * against an allowance rather than a fee, so the `RestrictOrigins` slot that
 * step writes is what keeps the chain from rejecting them outright.
 *
 * The lite sign-up is two transactions, never one, and this signer serves both
 * legs. `AliasWithProof` admits exactly one call,
 * `PeopleLite.set_alias_account(account, valid_at_block)`: it binds a lite
 * person's alias to `account` in a chain-approved context. Everything after
 * that binding rides `AliasWithAccount`, signed by the bound account — for the
 * game, `Game.sign_up_with_account_lite_invite`, which is `Pays::No`:
 *
 * ```ts
 * import { submitAndWatch } from "@parity/product-sdk-tx";
 * import { withLiteAlias } from "@parity/product-sdk-individuality";
 *
 * const signer = withLiteAlias(accounts.getProductAccountSigner(account), {
 *     tag: "AliasWithAccount",
 * });
 * await submitAndWatch(
 *     api.tx.Game.sign_up_with_account_lite_invite({ account, identifier_key, airdrops }),
 *     signer,
 * );
 * ```
 *
 * Nothing here chooses a chain, a product id or a TLD. The proof context, the
 * ring and the member key all live inside the caller's `createProof`, and the
 * call and its parameters — `account`, `valid_at_block` — belong to the
 * transaction being signed.
 *
 * Verified against the deployed encoding: the proof-variant bytes this
 * produces are byte-identical to the hand encoder that ran the two-transaction
 * flow live on previewnet (spec 1000036, individuality v0.12.1).
 */
import type { PolkadotSigner } from "polkadot-api";

import {
    PEOPLE_LITE_AUTH,
    type PeopleLiteAuthValue,
    encodePeopleLiteAuthInfo,
} from "./as-lite-alias-codec.js";
import { AS_PERSON, type ExtensionPipeline, encodeChecked } from "./as-person-codec.js";
import {
    type PapiSignedExtensions,
    buildImplication,
    implicationMessage,
    reviseMessage,
} from "./as-person-implication.js";
import { AsPersonError } from "./errors.js";
import {
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

/**
 * Which lite-person origin the transaction should run under.
 *
 * `AsLitePerson`, the fourth variant on chain, is deliberately absent: it
 * authenticates the canonical lite account itself, which stays in host
 * custody, so no product-side signer can ever be that origin.
 */
export type LiteAliasInfo =
    /**
     * Signed by an account already bound to the lite alias, via
     * `PeopleLite.set_alias_account`. Needs no proof.
     *
     * The chain reads `PeopleLite.AccountToAlias` for the signing account and
     * requires the stored ring revision to be current. When it is not, the
     * chain answers `Custom(172)` (stale alias) and `AliasWithAccountRevised`
     * is the variant that fixes it. That cannot be detected from here without
     * reading the ring root.
     */
    | { tag: "AliasWithAccount" }
    /**
     * No signature: a general transaction with a `None` origin, authorized by
     * the proof alone.
     *
     * The chain accepts this for `PeopleLite.set_alias_account` and nothing
     * else, requires the proof's context to be one the runtime allows accounts
     * to be bound in, and holds the call's `valid_at_block` to a tolerance
     * window measured from the current block. Replay protection is only the
     * binding itself: two of these with overlapping validity windows for
     * different accounts can replay each other indefinitely, so never keep two
     * alive at once.
     */
    | { tag: "AliasWithProof"; createProof: CreateRingVRFProof }
    /**
     * Signed, and moves the stored alias binding to the ring revision in force
     * now.
     *
     * The proof must resolve to the same alias and context the account was
     * originally bound to, or the chain answers `Custom(174)`.
     */
    | { tag: "AliasWithAccountRevised"; createProof: CreateRingVRFProof };

/**
 * Build the `PeopleLiteAuth` value for `info`, requesting a proof when the
 * variant needs one.
 *
 * Called after every other slot holds its final value, because two of the
 * three variants hash them. Same shape as the `AsPerson` builder, one
 * extension further down the pipeline — which matters: the implication slice
 * starts after `PeopleLiteAuth`, so the two extensions hash different byte
 * ranges of the same transaction.
 */
async function buildValue(
    pipeline: ExtensionPipeline,
    callData: Uint8Array,
    extensions: PapiSignedExtensions,
    info: LiteAliasInfo,
    aliasAccount: Uint8Array,
): Promise<PeopleLiteAuthValue> {
    switch (info.tag) {
        case "AliasWithAccount":
            return {
                tag: "AsLiteAliasWithAccount",
                nonce: nonceFrom(pipeline, extensions),
            };

        case "AliasWithProof": {
            const proof = await requestProof(
                info.createProof,
                implicationMessage(pipeline, callData, extensions, PEOPLE_LITE_AUTH),
            );
            return {
                tag: "AsLiteAliasWithProof",
                proof: proof.proof,
                ringIndex: proof.ringIndex,
                revision: proof.ringRevision,
                context: proof.contextualAlias.context,
            };
        }

        case "AliasWithAccountRevised": {
            const nonce = nonceFrom(pipeline, extensions);
            // This variant binds the implication plus a label, the bound account
            // and the nonce — the pallet hashes the tuple
            // `(inherited_implication, "revise", account, nonce)`, the same
            // construction `AsPerson` uses — so it needs the implication bytes
            // rather than the plain message.
            const implication = buildImplication(pipeline, callData, extensions, PEOPLE_LITE_AUTH);
            const proof = await requestProof(
                info.createProof,
                reviseMessage(implication, aliasAccount, nonce),
            );
            return {
                tag: "AsLiteAliasWithAccountRevised",
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
            throw new AsPersonError("unknown PeopleLiteAuth variant");
    }
}

/**
 * Wrap a signer so its transactions run under a lite-person origin.
 *
 * `signBytes` and `publicKey` pass through untouched. PAPI stamps `publicKey`
 * into the extrinsic and uses it to fetch the nonce, so it has to stay the
 * inner signer's.
 *
 * @param signer - the signer to wrap, e.g. from
 *   `AccountsProvider.getProductAccountSigner`.
 * @param info - which lite-person origin to use, and where the proof comes from.
 * @returns a `PolkadotSigner` usable anywhere the original was.
 */
export function withLiteAlias(signer: PolkadotSigner, info: LiteAliasInfo): PolkadotSigner {
    return withOriginExtension<PeopleLiteAuthValue>(signer, {
        identifier: PEOPLE_LITE_AUTH,
        unsigned: info.tag === "AliasWithProof",
        encode: encodePeopleLiteAuthInfo,
        buildValue: (pipeline, callData, extensions, aliasAccount) =>
            buildValue(pipeline, callData, extensions, info, aliasAccount),
    });
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { readExtensionPipeline } = await import("./as-person-codec.js");
    const { CHECK_NONCE } = await import("./origin-extension.js");

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

    const sign = async (info: LiteAliasInfo, extensions = papiExtensions()) => {
        const { signer, calls } = spySigner();
        const result = await withLiteAlias(signer, info).signTx(
            CALL_DATA,
            extensions,
            METADATA,
            123,
        );
        return { result, calls, seen: calls[0].extensions };
    };

    describe("withLiteAlias, shared behaviour", () => {
        test("sets RestrictOrigins to true", () => {
            // Both lite origins are restricted entities, and PAPI's default of
            // false is an immediate rejection for them.
            return sign({ tag: "AliasWithAccount" }).then(({ seen }) => {
                expect(hex(seen[RESTRICT_ORIGINS].value)).toBe("0x01");
            });
        });

        test("hashes the slice after PeopleLiteAuth, not the AsPerson one", async () => {
            // The identifier is load-bearing: PeopleLiteAuth sits four slots
            // after AsPerson, so a proof taken over the AsPerson implication is
            // a bad proof with nothing local to read.
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
                implicationMessage(PIPELINE, CALL_DATA, patched, PEOPLE_LITE_AUTH),
            );
            expect(seenMessage).not.toEqual(
                implicationMessage(PIPELINE, CALL_DATA, patched, AS_PERSON),
            );
        });

        test("writes PeopleLiteAuth last, and its value is outside its own hash", async () => {
            let seenMessage: Uint8Array | undefined;
            const { seen } = await sign({
                tag: "AliasWithProof",
                createProof: async (message) => {
                    seenMessage = message;
                    return RING_PROOF;
                },
            });

            // PeopleLiteAuth ends up holding the proof (Some, variant 2).
            expect(hex(seen[PEOPLE_LITE_AUTH].value).startsWith("0x0102")).toBe(true);

            // Re-hashing the final map, proof and all, reproduces the very
            // message the proof was taken over: the proof slot is outside its
            // own hash, which is what makes the write order sound.
            expect(seenMessage).toEqual(
                implicationMessage(PIPELINE, CALL_DATA, seen, PEOPLE_LITE_AUTH),
            );
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
            await withLiteAlias(signer, { tag: "AliasWithAccount" }).signTx(
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
            const { result } = await sign({ tag: "AliasWithAccount" });
            expect(hex(result)).toBe("0xdead");
        });

        test("passes publicKey and signBytes straight through", async () => {
            const { signer } = spySigner();
            const wrapped = withLiteAlias(signer, { tag: "AliasWithAccount" });
            expect(wrapped.publicKey).toBe(signer.publicKey);
            expect(hex(await wrapped.signBytes(Uint8Array.from([1])))).toBe("0xff");
            expect(signer.signBytes).toHaveBeenCalledOnce();
        });

        test("an unrecognized tag throws instead of silently encoding None", async () => {
            // None would run the call under a plain account origin, so it could
            // succeed while doing the wrong thing. Reachable from JavaScript,
            // including by passing the on-chain variant name by mistake.
            for (const tag of [
                "aliasWithAccount",
                "AsLiteAliasWithAccount",
                "AsLitePerson",
                undefined,
            ]) {
                await expect(sign({ tag } as unknown as LiteAliasInfo)).rejects.toThrow(
                    AsPersonError,
                );
            }
        });
    });

    describe("AliasWithAccount", () => {
        test("encodes variant 1 with the nonce PAPI already put in CheckNonce", async () => {
            const { seen } = await sign({ tag: "AliasWithAccount" }, papiExtensions(7));
            // Some, variant 1, then 7 as a plain u32. Taking the nonce from the
            // slot PAPI filled is what makes the two impossible to disagree —
            // the extension validates its own nonce, so they must be the same
            // number in two widths.
            expect(hex(seen[PEOPLE_LITE_AUTH].value)).toBe("0x010107000000");
        });

        test("tracks the nonce rather than assuming one", async () => {
            const { seen } = await sign({ tag: "AliasWithAccount" }, papiExtensions(300));
            expect(hex(seen[PEOPLE_LITE_AUTH].value)).toBe("0x01012c010000");
        });

        test("leaves VerifyMultiSignature absent so the host signs", async () => {
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
        const info = (createProof: CreateRingVRFProof = async () => RING_PROOF): LiteAliasInfo => ({
            tag: "AliasWithProof",
            createProof,
        });

        test("sets VerifyMultiSignature to Disabled so the origin is None", async () => {
            const { seen } = await sign(info());
            expect(hex(seen[VERIFY_SIGNATURE].value)).toBe("0x00");
            expect(hex(seen[VERIFY_SIGNATURE].additionalSigned)).toBe("0x");
        });

        test("encodes variant 2 from the returned proof, including the revision", async () => {
            const { seen } = await sign(info());
            expect(hex(seen[PEOPLE_LITE_AUTH].value)).toBe(
                `0x01020caabbcc0400000005000000${hex(CONTEXT).slice(2)}`,
            );
        });

        test("takes the context from the proof, not from the request", async () => {
            // Whichever call mints the proof decides the context — for the lite
            // ring that is the chain's `Score.score_context`, and it travels
            // inside the proof rather than as a parameter here.
            const other = Uint8Array.from({ length: 32 }, () => 0x99);
            const { seen } = await sign(
                info(async () => ({
                    ...RING_PROOF,
                    contextualAlias: { context: other, alias: new Uint8Array(32) },
                })),
            );
            expect(hex(seen[PEOPLE_LITE_AUTH].value).endsWith(hex(other).slice(2))).toBe(true);
        });

        test("calls createProof exactly once, with a 32-byte message", async () => {
            const createProof = vi.fn<CreateRingVRFProof>(async () => RING_PROOF);
            await sign(info(createProof));
            expect(createProof).toHaveBeenCalledOnce();
            expect(createProof.mock.calls[0][0]).toHaveLength(32);
        });

        test("reports a proof that resolves with the wrong shape as this package's error", async () => {
            const malformed = [
                async () => undefined,
                async () => ({}),
                async () => ({ proof: PROOF_BYTES, ringIndex: 1, ringRevision: 1 }),
            ] as unknown as CreateRingVRFProof[];

            for (const createProof of malformed) {
                await expect(sign(info(createProof))).rejects.toThrow(AsPersonError);
            }
        });

        test("keeps the underlying rejection as the cause, and does not sign", async () => {
            const boom = new Error("host unavailable");
            const { signer, calls } = spySigner();
            await withLiteAlias(signer, {
                tag: "AliasWithProof",
                createProof: async () => {
                    throw boom;
                },
            })
                .signTx(CALL_DATA, papiExtensions(), METADATA, 1)
                .then(
                    () => expect.unreachable("should have thrown"),
                    (error) => expect((error as Error).cause).toBe(boom),
                );
            expect(calls).toHaveLength(0);
        });
    });

    describe("AliasWithAccountRevised", () => {
        const info = (createProof: CreateRingVRFProof = async () => RING_PROOF): LiteAliasInfo => ({
            tag: "AliasWithAccountRevised",
            createProof,
        });

        test("encodes variant 3 with the nonce first", async () => {
            const { seen } = await sign(info(), papiExtensions(9));
            expect(hex(seen[PEOPLE_LITE_AUTH].value)).toBe(
                `0x0103090000000caabbcc0400000005000000${hex(CONTEXT).slice(2)}`,
            );
        });

        test("binds the revise message over the PeopleLiteAuth implication", async () => {
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
            const implication = buildImplication(PIPELINE, CALL_DATA, patched, PEOPLE_LITE_AUTH);
            expect(seenMessage).toEqual(reviseMessage(implication, PUBLIC_KEY, 9));
            // The two distinctions that matter: it is not the plain message, and
            // it is not the AsPerson implication.
            expect(seenMessage).not.toEqual(
                implicationMessage(PIPELINE, CALL_DATA, patched, PEOPLE_LITE_AUTH),
            );
            expect(seenMessage).not.toEqual(
                reviseMessage(
                    buildImplication(PIPELINE, CALL_DATA, patched, AS_PERSON),
                    PUBLIC_KEY,
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
