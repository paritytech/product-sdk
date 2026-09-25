// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * NFT claim credits: which credit roots a claimant holds credits under, the credits
 * themselves, and the hash each credit is.
 *
 * The People chain mints nothing. It awards claim credits, commits the credits of each
 * block to a Merkle root, and Asset Hub verifies a mint against that root. Both reads
 * go through the `NftCreditsApi` runtime APIs rather than storage, because only they
 * serve the proof a claim needs.
 *
 * A root is recorded in the block after the one it commits, so a credit awarded in the
 * newest block shows up one block later. A credit that spilled into a later buffer
 * waits for the tree of that buffer.
 *
 * A claimant is a {@link PlayerKey}. Credits awarded to an account and credits awarded
 * to the alias the same person later plays under live under separate keys, with no
 * link between them, so a full history takes one read per key.
 */
import { AccountId } from "polkadot-api";
import { err, normalizeError, ok, type Result } from "@parity/result";
import { blake2b256, bytesToHex, hexToBytes, utf8ToBytes } from "@parity/product-sdk-utils";
import { ProductIndividualityError } from "./errors.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import type { PlayerKey } from "./player-key.js";
import type { FinalizedSnapshot } from "./types.js";

/** A value of `NftCredits.NftClaimCreditRoots`, as the roots API returns it. */
export interface RawCreditRoot {
    game_index: number;
    root: string;
    leaf_count: number;
    timestamp: number;
}

/** One inclusion proof, as the proofs API returns it. */
export interface RawCreditProof {
    credit: string;
    leaf_index: number;
    proof: string[];
}

/** The proofs API answer, a PAPI `ResultPayload` over `NftClaimCreditProofError`. */
export type RawCreditProofs =
    | { success: true; value: RawCreditProof[] }
    | { success: false; value: { type: string } };

/**
 * Structural, so a test double satisfies it. Matched by hand against the paseo
 * descriptors on 2026-09-25:
 *
 * ```
 * NftCreditsApi.nft_claim_credit_roots:  [claimant: AccountOrPerson] => Array<[number, NftClaimCreditRootInfo]>
 * NftCreditsApi.nft_claim_credit_proofs: [tree_block: number, claimant: AccountOrPerson] => ResultPayload<Array<NftClaimCreditProof>, NftClaimCreditProofError>
 * ```
 */
export interface CreditsChain extends PinnedChain {
    individuality: {
        apis: {
            NftCreditsApi: {
                nft_claim_credit_roots: (
                    claimant: PlayerKey,
                    options: ReadAt,
                ) => Promise<Array<[number, RawCreditRoot]>>;
                nft_claim_credit_proofs: (
                    treeBlock: number,
                    claimant: PlayerKey,
                    options: ReadAt,
                ) => Promise<RawCreditProofs>;
            };
        };
    };
}

/**
 * One credit tree holding at least one credit of the claimant.
 *
 * Roots outlive the credits they commit, so a game whose credits were pruned is still
 * here with the time it was played.
 */
export interface CreditRoot {
    /** Block whose credit tree the root commits. */
    awardBlock: number;
    gameIndex: number;
    /** Unix seconds the root was recorded. */
    awardedAt: number;
    /** Leaves in the whole tree, other claimants included. */
    leafCount: number;
    root: string;
}

/** One credit the chain has awarded and can still prove. */
export interface AwardedCredit {
    /** Lowercase hex, byte for byte what {@link creditHash} derives. */
    hash: string;
    gameIndex: number;
    /** Unix seconds the root of its tree was recorded. */
    awardedAt: number;
    /** Block whose credit tree commits it. */
    awardBlock: number;
    leafIndex: number;
    /** Sibling hashes from the leaf up to the root, which a claim on Asset Hub presents. */
    proof: string[];
}

export interface CreditRootsResult {
    at: FinalizedSnapshot;
    /** Ascending by block. */
    roots: CreditRoot[];
}

export interface CreditsResult {
    at: FinalizedSnapshot;
    /** Ascending by block, then in leaf order. */
    credits: AwardedCredit[];
    /**
     * Blocks whose credits the chain no longer retains. Their roots still appear in
     * {@link readCreditRoots}, but their credits can no longer be read or proven here.
     */
    prunedBlocks: number[];
}

/** Options for {@link readCreditRoots} and {@link readCredits}. */
export interface ReadCreditsOptions {
    claimant: PlayerKey;
    signal?: AbortSignal;
}

/** The claimant credit roots, at one pinned finalized block. */
export async function readCreditRoots(
    chain: CreditsChain,
    options: ReadCreditsOptions,
): Promise<Result<CreditRootsResult, ProductIndividualityError>> {
    try {
        const snapshot = await pinBlock(chain, options.signal);
        const roots = await chain.individuality.apis.NftCreditsApi.nft_claim_credit_roots(
            options.claimant,
            readAt(snapshot, options.signal),
        );
        return ok({
            at: snapshot,
            roots: roots.map(([awardBlock, root]) => ({
                awardBlock,
                gameIndex: root.game_index,
                awardedAt: root.timestamp,
                leafCount: root.leaf_count,
                root: root.root,
            })),
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/**
 * The claimant credits with their proofs, at one pinned finalized block.
 *
 * A block whose credits were pruned contributes nothing and is listed in
 * `prunedBlocks` instead of failing the read. Any other refusal from the proofs API
 * means the chain contradicted its own roots at the same block, and arrives on the
 * `err` channel.
 */
export async function readCredits(
    chain: CreditsChain,
    options: ReadCreditsOptions,
): Promise<Result<CreditsResult, ProductIndividualityError>> {
    try {
        const { claimant, signal } = options;
        const api = chain.individuality.apis.NftCreditsApi;
        const snapshot = await pinBlock(chain, signal);
        const at = readAt(snapshot, signal);

        const roots = await api.nft_claim_credit_roots(claimant, at);
        const blocks = await Promise.all(
            roots.map(async ([awardBlock, root]) => ({
                awardBlock,
                root,
                proofs: await api.nft_claim_credit_proofs(awardBlock, claimant, at),
            })),
        );

        const credits: AwardedCredit[] = [];
        const prunedBlocks: number[] = [];
        for (const { awardBlock, root, proofs } of blocks) {
            if (!proofs.success) {
                if (proofs.value.type !== "AwardsPruned") {
                    throw new ProductIndividualityError(
                        "the chain refused proofs for a credit root it listed",
                        { cause: proofs.value },
                    );
                }
                prunedBlocks.push(awardBlock);
                continue;
            }
            for (const leaf of proofs.value) {
                credits.push({
                    hash: leaf.credit.toLowerCase(),
                    gameIndex: root.game_index,
                    awardedAt: root.timestamp,
                    awardBlock,
                    leafIndex: leaf.leaf_index,
                    proof: leaf.proof,
                });
            }
        }
        return ok({ at: snapshot, credits, prunedBlocks });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** A Rust byte-string literal, so the raw bytes with no length prefix. */
const CREDIT_PREFIX = utf8ToBytes("polkadot-pop-game");
const U8_MAX = 0xff;
const U32_MAX = 0xff_ff_ff_ff;
const PLAYER_ID_BYTES = 32;
const ALIAS_HEX = /^0x[0-9a-fA-F]{64}$/;

/** SCALE `AccountOrPerson`: the variant index, then the 32 raw bytes. */
function encodePlayerKey(player: PlayerKey, role: "attester" | "attestee"): Uint8Array {
    const out = new Uint8Array(1 + PLAYER_ID_BYTES);
    if (player.type === "Account") {
        let account: Uint8Array;
        try {
            account = AccountId().enc(player.value);
        } catch (cause) {
            throw new ProductIndividualityError(`credit ${role} is not a valid address`, {
                cause,
            });
        }
        if (account.length !== PLAYER_ID_BYTES) {
            throw new ProductIndividualityError(
                `credit ${role} account must be ${PLAYER_ID_BYTES} bytes`,
            );
        }
        out[0] = 0;
        out.set(account, 1);
        return out;
    }
    if (!ALIAS_HEX.test(player.value)) {
        throw new ProductIndividualityError(
            `credit ${role} alias must be ${PLAYER_ID_BYTES} bytes of hex`,
        );
    }
    out[0] = 1;
    out.set(hexToBytes(player.value.slice(2)), 1);
    return out;
}

/**
 * The credit one attestation awards, as lowercase hex:
 * `blake2b-256("polkadot-pop-game" ++ game_index ++ round ++ attester ++ attestee)`.
 *
 * `game_index` is a little-endian `u32`, `round` a `u8`, and each player a SCALE
 * `AccountOrPerson`. An account hashes as its raw bytes, so its SS58 prefix does not
 * matter.
 *
 * @throws ProductIndividualityError when a number is out of range or a player does
 *   not encode.
 */
export function creditHash(options: {
    gameIndex: number;
    round: number;
    attester: PlayerKey;
    attestee: PlayerKey;
}): string {
    const { gameIndex, round } = options;
    if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex > U32_MAX) {
        throw new ProductIndividualityError("credit game index must be a u32");
    }
    if (!Number.isInteger(round) || round < 0 || round > U8_MAX) {
        throw new ProductIndividualityError("credit round must be a u8");
    }
    const attester = encodePlayerKey(options.attester, "attester");
    const attestee = encodePlayerKey(options.attestee, "attestee");

    const preimage = new Uint8Array(
        CREDIT_PREFIX.length + 4 + 1 + attester.length + attestee.length,
    );
    const view = new DataView(preimage.buffer);
    let offset = 0;
    preimage.set(CREDIT_PREFIX, offset);
    offset += CREDIT_PREFIX.length;
    view.setUint32(offset, gameIndex, true);
    offset += 4;
    view.setUint8(offset, round);
    offset += 1;
    preimage.set(attester, offset);
    offset += attester.length;
    preimage.set(attestee, offset);
    return `0x${bytesToHex(blake2b256(preimage))}`;
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapErr, unwrapOk } = await import("@parity/result");
    const { Enum } = await import("polkadot-api");

    const hex = (bytes: number[]) =>
        `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const account = (byte: number) => AccountId().dec(new Uint8Array(32).fill(byte));
    const hex32 = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

    const BLOCK = { hash: `0x${"77".repeat(32)}`, number: 9_000 };
    const ME: PlayerKey = Enum("Account", account(200));

    interface FakeState {
        roots?: Array<[number, RawCreditRoot]>;
        proofs?: Record<number, RawCreditProof[] | string>;
        failOn?: "roots" | "proofs";
    }

    const root = (gameIndex: number, timestamp: number, leafCount = 4): RawCreditRoot => ({
        game_index: gameIndex,
        root: hex32(gameIndex),
        leaf_count: leafCount,
        timestamp,
    });

    const proof = (credit: string, leafIndex = 0): RawCreditProof => ({
        credit,
        leaf_index: leafIndex,
        proof: [hex32(0xee), hex32(0xef)],
    });

    function fakeChain(state: FakeState) {
        const calls: Array<{ call: string; claimant: PlayerKey; at: string }> = [];
        const chain: CreditsChain = {
            individuality: {
                apis: {
                    NftCreditsApi: {
                        nft_claim_credit_roots: async (claimant, options) => {
                            options.signal?.throwIfAborted();
                            calls.push({ call: "roots", claimant, at: options.at });
                            if (state.failOn === "roots") throw new Error("roots unreachable");
                            return state.roots ?? [];
                        },
                        nft_claim_credit_proofs: async (treeBlock, claimant, options) => {
                            calls.push({ call: `proofs:${treeBlock}`, claimant, at: options.at });
                            if (state.failOn === "proofs") throw new Error("proofs unreachable");
                            const leaves = state.proofs?.[treeBlock] ?? [];
                            return typeof leaves === "string"
                                ? { success: false, value: { type: leaves } }
                                : { success: true, value: leaves };
                        },
                    },
                },
            },
            raw: { individuality: { getFinalizedBlock: async () => BLOCK } },
        };
        return { chain, calls };
    }

    describe("creditHash", () => {
        // Both vectors come from `nft_claim_credit_spec` in individuality
        // `pallets/game/src/tests.rs`, so a changed preimage fails here rather
        // than as an empty pack.
        test("matches the pallet vector for an account attester and a person attestee", () => {
            expect(
                creditHash({
                    gameIndex: 32,
                    round: 5,
                    attester: Enum("Account", account(1)),
                    attestee: Enum("Person", hex32(2)),
                }),
            ).toBe(
                hex([
                    135, 205, 206, 159, 168, 238, 124, 124, 43, 173, 199, 120, 3, 56, 148, 117, 67,
                    126, 78, 190, 126, 15, 187, 177, 224, 186, 115, 113, 73, 121, 224, 196,
                ]),
            );
        });

        test("matches the pallet vector for a person attester and an account attestee", () => {
            expect(
                creditHash({
                    gameIndex: 35,
                    round: 9,
                    attester: Enum("Person", hex32(3)),
                    attestee: Enum("Account", account(4)),
                }),
            ).toBe(
                hex([
                    86, 240, 179, 9, 73, 32, 219, 236, 202, 127, 104, 185, 169, 196, 74, 74, 168,
                    221, 30, 78, 35, 75, 128, 151, 175, 250, 203, 174, 199, 71, 243, 194,
                ]),
            );
        });

        test("is sensitive to every field, to the direction, and to the variant", () => {
            const base = {
                gameIndex: 7,
                round: 1,
                attester: Enum("Account", account(9)),
                attestee: Enum("Account", account(8)),
            } as const;
            const hash = creditHash(base);
            expect(creditHash({ ...base, gameIndex: 8 })).not.toBe(hash);
            expect(creditHash({ ...base, round: 2 })).not.toBe(hash);
            expect(
                creditHash({ ...base, attester: base.attestee, attestee: base.attester }),
            ).not.toBe(hash);
            expect(creditHash({ ...base, attester: Enum("Person", hex32(9)) })).not.toBe(hash);
        });

        test("hashes an account by its bytes, whatever its SS58 prefix", () => {
            const generic = account(9);
            const polkadot = AccountId(0).dec(AccountId().enc(generic));
            const base = { gameIndex: 7, round: 1, attestee: Enum("Account", account(8)) };
            expect(creditHash({ ...base, attester: Enum("Account", polkadot) })).toBe(
                creditHash({ ...base, attester: Enum("Account", generic) }),
            );
        });

        test("accepts an upper-case alias", () => {
            const base = { gameIndex: 7, round: 1, attestee: Enum("Account", account(8)) };
            expect(creditHash({ ...base, attester: Enum("Person", `0x${"AB".repeat(32)}`) })).toBe(
                creditHash({ ...base, attester: Enum("Person", `0x${"ab".repeat(32)}`) }),
            );
        });

        test.each([
            ["a negative game index", { gameIndex: -1 }],
            ["a game index past u32", { gameIndex: 2 ** 32 }],
            ["a fractional game index", { gameIndex: 1.5 }],
            ["a round past u8", { round: 256 }],
            ["a negative round", { round: -1 }],
        ])("rejects %s", (_, override) => {
            expect(() =>
                creditHash({
                    gameIndex: 7,
                    round: 1,
                    attester: Enum("Account", account(9)),
                    attestee: Enum("Account", account(8)),
                    ...override,
                }),
            ).toThrow(ProductIndividualityError);
        });

        test("rejects an alias that is not 32 bytes, and an address that does not decode", () => {
            const base = { gameIndex: 7, round: 1, attestee: Enum("Account", account(8)) };
            expect(() => creditHash({ ...base, attester: Enum("Person", "0xabcd") })).toThrow(
                /attester alias/,
            );
            expect(() => creditHash({ ...base, attester: Enum("Account", "nope") })).toThrow(
                /attester is not a valid address/,
            );
        });
    });

    describe("readCreditRoots", () => {
        test("maps each block and root, in the order the chain returns them", async () => {
            const { chain } = fakeChain({
                roots: [
                    [10, root(7, 1_700_000_000, 4)],
                    [20, root(8, 1_700_000_100, 6)],
                ],
            });
            expect(unwrapOk(await readCreditRoots(chain, { claimant: ME }))).toEqual({
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
                roots: [
                    {
                        awardBlock: 10,
                        gameIndex: 7,
                        awardedAt: 1_700_000_000,
                        leafCount: 4,
                        root: hex32(7),
                    },
                    {
                        awardBlock: 20,
                        gameIndex: 8,
                        awardedAt: 1_700_000_100,
                        leafCount: 6,
                        root: hex32(8),
                    },
                ],
            });
        });

        test("asks about the claimant key as given, at the pinned block", async () => {
            const person: PlayerKey = Enum("Person", hex32(9));
            const { chain, calls } = fakeChain({});
            await readCreditRoots(chain, { claimant: person });
            expect(calls).toEqual([{ call: "roots", claimant: person, at: BLOCK.hash }]);
        });

        test("a transport failure arrives on the err channel with its cause", async () => {
            const { chain } = fakeChain({ failOn: "roots" });
            const error = unwrapErr(await readCreditRoots(chain, { claimant: ME }));
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect((error.cause as Error).message).toBe("roots unreachable");
        });
    });

    describe("readCredits", () => {
        test("dates every credit from the root of its own block, and keeps its proof", async () => {
            const { chain } = fakeChain({
                roots: [
                    [10, root(7, 1_700_000_000)],
                    [20, root(8, 1_700_000_100)],
                ],
                proofs: { 10: [proof(hex32(0xbb), 3)], 20: [proof(hex32(0xcc), 1)] },
            });
            expect(unwrapOk(await readCredits(chain, { claimant: ME }))).toEqual({
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
                credits: [
                    {
                        hash: hex32(0xbb),
                        gameIndex: 7,
                        awardedAt: 1_700_000_000,
                        awardBlock: 10,
                        leafIndex: 3,
                        proof: [hex32(0xee), hex32(0xef)],
                    },
                    {
                        hash: hex32(0xcc),
                        gameIndex: 8,
                        awardedAt: 1_700_000_100,
                        awardBlock: 20,
                        leafIndex: 1,
                        proof: [hex32(0xee), hex32(0xef)],
                    },
                ],
                prunedBlocks: [],
            });
        });

        test("keeps every leaf a block returns, since the API is already scoped to the claimant", async () => {
            const { chain } = fakeChain({
                roots: [[10, root(7, 1_700_000_000)]],
                proofs: { 10: [proof(hex32(0xbb), 0), proof(hex32(0xcc), 1)] },
            });
            const { credits } = unwrapOk(await readCredits(chain, { claimant: ME }));
            expect(credits.map((credit) => credit.hash)).toEqual([hex32(0xbb), hex32(0xcc)]);
        });

        test("lowercases the credit so it compares equal to creditHash", async () => {
            const { chain } = fakeChain({
                roots: [[10, root(7, 1_700_000_000)]],
                proofs: { 10: [proof(`0x${"AB".repeat(32)}`)] },
            });
            const { credits } = unwrapOk(await readCredits(chain, { claimant: ME }));
            expect(credits[0]?.hash).toBe(`0x${"ab".repeat(32)}`);
        });

        test("reports a pruned block and still reads the others", async () => {
            const { chain } = fakeChain({
                roots: [
                    [10, root(7, 1_700_000_000)],
                    [20, root(8, 1_700_000_100)],
                ],
                proofs: { 10: "AwardsPruned", 20: [proof(hex32(0xcc))] },
            });
            const result = unwrapOk(await readCredits(chain, { claimant: ME }));
            expect(result.prunedBlocks).toEqual([10]);
            expect(result.credits.map((credit) => credit.awardBlock)).toEqual([20]);
        });

        test("fails on any other refusal, which contradicts the roots read at the same block", async () => {
            const { chain } = fakeChain({
                roots: [[10, root(7, 1_700_000_000)]],
                proofs: { 10: "UnknownCreditTree" },
            });
            const error = unwrapErr(await readCredits(chain, { claimant: ME }));
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(error.cause).toEqual({ type: "UnknownCreditTree" });
        });

        test("reads every block at the pinned block, for the same claimant", async () => {
            const { chain, calls } = fakeChain({
                roots: [
                    [10, root(7, 1_700_000_000)],
                    [20, root(8, 1_700_000_100)],
                ],
            });
            await readCredits(chain, { claimant: ME });
            expect(calls.map((call) => call.call)).toEqual(["roots", "proofs:10", "proofs:20"]);
            expect(new Set(calls.map((call) => call.at))).toEqual(new Set([BLOCK.hash]));
            expect(new Set(calls.map((call) => call.claimant))).toEqual(new Set([ME]));
        });

        test("asks for no proofs when the claimant has no roots", async () => {
            const { chain, calls } = fakeChain({});
            expect(unwrapOk(await readCredits(chain, { claimant: ME }))).toEqual({
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
                credits: [],
                prunedBlocks: [],
            });
            expect(calls.map((call) => call.call)).toEqual(["roots"]);
        });

        test("a transport failure on a proof read arrives on the err channel", async () => {
            const { chain } = fakeChain({
                roots: [[10, root(7, 1_700_000_000)]],
                failOn: "proofs",
            });
            const error = unwrapErr(await readCredits(chain, { claimant: ME }));
            expect((error.cause as Error).message).toBe("proofs unreachable");
        });

        test("an already-aborted signal costs no round trip", async () => {
            const { chain, calls } = fakeChain({ roots: [[10, root(7, 1_700_000_000)]] });
            const controller = new AbortController();
            controller.abort();
            const error = unwrapErr(
                await readCredits(chain, { claimant: ME, signal: controller.signal }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(calls).toHaveLength(0);
        });
    });
}
