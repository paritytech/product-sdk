// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `getCredits`, every NFT claim credit one claimant holds, with where each stands.
 *
 * A credit is awarded on the People chain and spent on Asset Hub, so the read
 * spans both. The People side says which award blocks the claimant has credits
 * in, which of those blocks are rooted, and for a rooted block the credit hashes
 * with the leaves a claim spends. Rootless blocks, normally only the newest, are
 * read from the award chunks instead so a fresh award shows within seconds. The
 * Asset Hub side says whether the root arrived and, per leaf index, whether it
 * is spent, which is what turns a credit into `earned`, `claimable` or `claimed`.
 *
 * The shape follows `fetchCredits` and `fetchClaimStates` in scarcity-stash, with
 * one difference: a block whose awards were pruned before its proofs were read
 * comes back as `unprovable` rather than being dropped, because a shelf that
 * silently loses old credits is worse than one that says why it cannot claim them.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { pinBlock, pinFinalized, readAt, type NftsChain, type NftsCreditsChain } from "./chain.js";
import { matchChainEntryError, ProductNftsError } from "./errors.js";
import type {
    Claimant,
    Credit,
    CreditsResult,
    CreditState,
    FinalizedSnapshot,
    RawCreditAward,
    RawCreditRoot,
    ReadAt,
} from "./types.js";

export interface GetCreditsOptions {
    /** Whose credits. Accounts and person aliases are keyed apart on chain. */
    claimant: Claimant;
    /** Join a block another Asset Hub read already pinned. */
    at?: FinalizedSnapshot;
    /** Forwarded into every underlying pull, so an aborted caller stops the batch. */
    signal?: AbortSignal;
}

/** The enum PAPI expects for `AccountOrPerson`. */
export function toClaimantKey(claimant: Claimant): { type: "Account" | "Person"; value: string } {
    return claimant.tag === "Account"
        ? { type: "Account", value: claimant.address }
        : { type: "Person", value: claimant.alias };
}

function sameClaimant(
    key: { type: "Account" | "Person"; value: string },
    claimant: Claimant,
): boolean {
    if (claimant.tag === "Account") {
        return key.type === "Account" && key.value === claimant.address;
    }
    return key.type === "Person" && key.value.toLowerCase() === claimant.alias.toLowerCase();
}

/**
 * How many award chunks one read asks for at a time.
 *
 * A block holds at most `CHUNKS_PER_TREE` chunks and one award reads one chunk,
 * so a game block during reporting can spill past a small window. The window
 * widens while its last chunk came back non-empty, so the cost is one keyed
 * read per window rather than one per chunk.
 */
const CHUNK_WINDOW = 16;

async function readAwardChunks(
    awards: NftsCreditsChain["individuality"]["query"]["NftCredits"]["NftClaimCreditAwards"],
    block: number,
    at: ReadAt,
): Promise<RawCreditAward[]> {
    const found: RawCreditAward[] = [];
    for (let from = 0; ; from += CHUNK_WINDOW) {
        const keys = Array.from(
            { length: CHUNK_WINDOW },
            (_, i) => [block, from + i] as [number, number],
        );
        const chunks = await awards.getValues(keys, at);
        for (const chunk of chunks) found.push(...chunk);
        if ((chunks[chunks.length - 1]?.length ?? 0) === 0) return found;
    }
}

/**
 * The proof errors that mean the awards are gone, rather than that something
 * disagrees. `RootMismatch`, `LeafCountMismatch` and `LeafIndexOutOfBounds` are
 * integrity failures and land on the `err` channel instead.
 */
const UNPROVABLE = new Set(["AwardsPruned", "UnknownCreditTree"]);

function unprovable(
    awardBlock: number,
    awardedAt: number | null,
    gameIndex: number | null,
): Credit {
    return { hash: null, awardBlock, awardedAt, gameIndex, leafIndex: null, state: "unprovable" };
}

/** Bit `leafIndex` of the bitmap, least significant bit first, as the pallet stores it. */
function isLeafClaimed(bitmap: Uint8Array, leafIndex: number): boolean {
    const byte = bitmap[leafIndex >> 3];
    return byte !== undefined && ((byte >> (leafIndex & 7)) & 1) === 1;
}

/** A credit hash as the maps key it: lowercase, `0x` prefixed. */
function normalizeHex(value: string): string {
    const lower = value.toLowerCase();
    return lower.startsWith("0x") ? lower : `0x${lower}`;
}

/**
 * Read every credit a claimant holds, newest award block first.
 *
 * Two pinned blocks, one per chain, both reported in `at`. Nothing here is
 * proportional to the chain: the award blocks and roots come back in two keyed
 * reads, the proofs in one runtime call per rooted block, the award chunks in
 * one keyed read per rootless block window, and the claim state in two keyed
 * reads over the rooted blocks, `CreditTrees` and the `ClaimedLeaves` bitmaps.
 * A claimant with nothing awarded is an empty list, not an error.
 *
 * @example
 * ```ts
 * const chain = await getChainAPI("paseo");
 * const result = await getCredits(chain, { claimant: { tag: "Account", address } });
 * if (result.ok) {
 *     for (const credit of result.value.credits) {
 *         console.log(credit.hash, credit.state, credit.awardedAt);
 *     }
 * }
 * ```
 */
export async function getCredits(
    chain: NftsChain & NftsCreditsChain,
    options: GetCreditsOptions,
): Promise<Result<CreditsResult, ProductNftsError>> {
    try {
        const { claimant, signal } = options;
        const [people, assetHub] = await Promise.all([
            pinFinalized(chain.raw.individuality, signal),
            pinBlock(chain, signal, options.at),
        ]);
        const peopleAt = readAt(people, signal);
        const assetHubAt = readAt(assetHub, signal);
        const key = toClaimantKey(claimant);
        const credits = chain.individuality.query.NftCredits;
        const api = chain.individuality.apis.NftCreditsApi;

        const [blocks, roots] = await Promise.all([
            credits.NftClaimCreditBlocks.getValue(key, peopleAt),
            api.nft_claim_credit_roots(key, peopleAt),
        ]);
        const rooted = new Map<number, RawCreditRoot>(roots);
        const awardBlocks = blocks ?? [];
        const rootless = awardBlocks.filter((block) => !rooted.has(block));

        const [proofs, chunks, trees] = await Promise.all([
            Promise.all(
                [...rooted.keys()].map((block) =>
                    api.nft_claim_credit_proofs(block, key, peopleAt),
                ),
            ),
            Promise.all(
                rootless.map((block) =>
                    readAwardChunks(credits.NftClaimCreditAwards, block, peopleAt),
                ),
            ),
            chain.assetHub.query.NftClaims.CreditTrees.getValues(
                [...rooted.keys()].map((block) => [block] as [number]),
                assetHubAt,
            ),
        ]);

        const rootedBlocks = [...rooted.keys()];
        // Every rooted block, not only the ones whose tree is still on Asset Hub:
        // the bitmap outlives the tree, so a claim made before the sweep still
        // reads as claimed after it.
        const bitmaps =
            rootedBlocks.length === 0
                ? []
                : await chain.assetHub.query.NftClaims.ClaimedLeaves.getValues(
                      rootedBlocks.map((block) => [block] as [number]),
                      assetHubAt,
                  );

        const found: Credit[] = [];
        rootedBlocks.forEach((block, index) => {
            const info = rooted.get(block) as RawCreditRoot;
            const proof = proofs[index];
            if (!proof.success) {
                if (!UNPROVABLE.has(proof.value.type)) {
                    throw new ProductNftsError(
                        `nft_claim_credit_proofs refused award block ${block}: ${proof.value.type}`,
                    );
                }
                // The awards went before this read, and the hashes with them, so
                // how many credits the block held is unknown too. One entry per
                // block says the block counted.
                found.push(unprovable(block, info.timestamp, info.game_index));
                return;
            }
            const bitmap = bitmaps[index] ?? new Uint8Array();
            const treeArrived = trees[index] !== undefined;
            for (const entry of proof.value) {
                const state: CreditState = isLeafClaimed(bitmap, entry.leaf_index)
                    ? "claimed"
                    : treeArrived
                      ? "claimable"
                      : "earned";
                found.push({
                    hash: normalizeHex(entry.credit),
                    awardBlock: block,
                    awardedAt: info.timestamp,
                    gameIndex: info.game_index,
                    leafIndex: entry.leaf_index,
                    state,
                });
            }
        });
        rootless.forEach((block, index) => {
            const mine = chunks[index].filter((award) => sameClaimant(award.claimant, claimant));
            if (mine.length === 0) {
                // No root and no awards left. A block still to come has neither
                // yet, and one whose root expired has lost both, and only the
                // block number tells them apart.
                found.push(
                    block > people.blockNumber
                        ? { ...unprovable(block, null, null), state: "earned" }
                        : unprovable(block, null, null),
                );
                return;
            }
            for (const award of mine) {
                found.push({
                    hash: normalizeHex(award.credit),
                    awardBlock: block,
                    awardedAt: null,
                    gameIndex: null,
                    leafIndex: null,
                    state: "earned",
                });
            }
        });

        found.sort((a, b) => b.awardBlock - a.awardBlock);
        return ok({ at: { individuality: people, assetHub }, credits: found });
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const PEOPLE = { hash: `0x${"11".repeat(32)}`, number: 500 };
    const ASSET_HUB = { hash: `0x${"22".repeat(32)}`, number: 900 };
    const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const claimant = { tag: "Account", address: ALICE } as const;
    type Key = { type: "Account" | "Person"; value: string };
    const key: Key = { type: "Account", value: ALICE };
    const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

    function fakeChain(state: {
        blocks?: number[];
        roots?: Array<[number, RawCreditRoot]>;
        proofs?: Record<number, { success: boolean; value: unknown }>;
        awards?: Record<number, Array<{ claimant: Key; credit: string }>>;
        trees?: number[];
        claimed?: Record<number, number[]>;
    }) {
        const calls: string[] = [];
        const chain = {
            individuality: {
                query: {
                    NftCredits: {
                        NftClaimCreditBlocks: {
                            getValue: async (_k: unknown, at: ReadAt) => {
                                calls.push(`blocks@${at.at.slice(0, 4)}`);
                                return state.blocks;
                            },
                        },
                        NftClaimCreditAwards: {
                            getValues: async (keys: Array<[number, number]>) => {
                                calls.push(
                                    `awards:${keys[0]?.[0]}:${keys[0]?.[1]}..${keys.at(-1)?.[1]}`,
                                );
                                // One award per chunk, so a block with more awards
                                // than the window spills into a second window.
                                return keys.map(([block, chunk]) => {
                                    const row = state.awards?.[block]?.[chunk];
                                    return row === undefined ? [] : [row];
                                });
                            },
                        },
                    },
                },
                apis: {
                    NftCreditsApi: {
                        nft_claim_credit_roots: async () => {
                            calls.push("roots");
                            return state.roots ?? [];
                        },
                        nft_claim_credit_proofs: async (block: number) => {
                            calls.push(`proofs:${block}`);
                            return state.proofs?.[block] ?? { success: true, value: [] };
                        },
                    },
                },
            },
            assetHub: {
                query: {
                    NftClaims: {
                        CreditTrees: {
                            getValues: async (keys: Array<[number]>, at: ReadAt) => {
                                calls.push(
                                    `trees:${keys.map(([b]) => b).join(",")}@${at.at.slice(0, 4)}`,
                                );
                                return keys.map(([b]) =>
                                    (state.trees ?? []).includes(b)
                                        ? { game_index: 1, root: h(b), leaf_count: 1, timestamp: 0 }
                                        : undefined,
                                );
                            },
                        },
                        ClaimedLeaves: {
                            getValues: async (keys: Array<[number]>) => {
                                calls.push(`claimed:${keys.map(([b]) => b).join(",")}`);
                                return keys.map(([b]) => {
                                    const bits = new Uint8Array(4);
                                    for (const i of state.claimed?.[b] ?? [])
                                        bits[i >> 3] |= 1 << (i & 7);
                                    return bits;
                                });
                            },
                        },
                    },
                },
            },
            raw: {
                individuality: { getFinalizedBlock: async () => PEOPLE },
                assetHub: { getFinalizedBlock: async () => ASSET_HUB },
            },
        } as unknown as NftsChain & NftsCreditsChain;
        return { chain, calls };
    }

    const root = (block: number, game = 7): [number, RawCreditRoot] => [
        block,
        { game_index: game, root: h(block), leaf_count: 2, timestamp: 1_700_000_000 + block },
    ];
    const proof = (credits: number[]) => ({
        success: true,
        value: credits.map((c, i) => ({ credit: h(c), leaf_index: i, proof: [] })),
    });

    describe("getCredits", () => {
        test("a claimant with no award blocks has no credits, and reads nothing else", async () => {
            const { chain, calls } = fakeChain({ blocks: undefined });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits).toEqual([]);
            expect(result.value.at).toEqual({
                individuality: { blockHash: PEOPLE.hash, blockNumber: PEOPLE.number },
                assetHub: { blockHash: ASSET_HUB.hash, blockNumber: ASSET_HUB.number },
            });
            expect(calls.filter((c) => c.startsWith("proofs") || c.startsWith("claimed"))).toEqual(
                [],
            );
        });

        test("a rooted block whose root reached Asset Hub is claimable, and claimed once spent", async () => {
            const { chain } = fakeChain({
                blocks: [10],
                roots: [root(10)],
                proofs: { 10: proof([1, 2]) },
                trees: [10],
                claimed: { 10: [1] },
            });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits.map((c) => [c.hash, c.state, c.leafIndex])).toEqual([
                [h(1), "claimable", 0],
                [h(2), "claimed", 1],
            ]);
            expect(result.value.credits[0]).toMatchObject({
                awardBlock: 10,
                awardedAt: 1_700_000_010,
                gameIndex: 7,
            });
        });

        test("a rooted block Asset Hub has not received is earned", async () => {
            const { chain, calls } = fakeChain({
                blocks: [10],
                roots: [root(10)],
                proofs: { 10: proof([1]) },
                trees: [],
            });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits[0].state).toBe("earned");
            expect(result.value.credits[0].leafIndex).toBe(0);
            expect(calls).toContain("claimed:10");
        });

        test("a claim made before the tree was swept still reads as claimed after it", async () => {
            const { chain } = fakeChain({
                blocks: [10],
                roots: [root(10)],
                proofs: { 10: proof([1, 2]) },
                trees: [],
                claimed: { 10: [0] },
            });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits.map((c) => c.state)).toEqual(["claimed", "earned"]);
        });

        test("a leaf past the first byte of the bitmap is read from its own byte", async () => {
            const { chain } = fakeChain({
                blocks: [10],
                roots: [root(10)],
                proofs: { 10: proof(Array.from({ length: 11 }, (_, i) => i + 1)) },
                trees: [10],
                claimed: { 10: [9] },
            });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const states = result.value.credits.map((c) => [c.leafIndex, c.state]);
            expect(states.filter(([, state]) => state === "claimed")).toEqual([[9, "claimed"]]);
        });

        test("a rootless block is read from the awards buffer, for this claimant only", async () => {
            const { chain } = fakeChain({
                blocks: [11],
                roots: [],
                awards: {
                    11: [
                        { claimant: key, credit: h(5) },
                        { claimant: { type: "Account", value: "5Bob" }, credit: h(6) },
                    ],
                },
            });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits).toEqual([
                {
                    hash: h(5),
                    awardBlock: 11,
                    awardedAt: null,
                    gameIndex: null,
                    leafIndex: null,
                    state: "earned",
                },
            ]);
        });

        test("a rootless block with more awards than one window is read whole", async () => {
            const rows = Array.from({ length: 20 }, (_, i) => ({
                claimant: key,
                credit: h(100 + i),
            }));
            const { chain, calls } = fakeChain({ blocks: [11], roots: [], awards: { 11: rows } });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits).toHaveLength(20);
            expect(calls.filter((c) => c.startsWith("awards:11"))).toEqual([
                "awards:11:0..15",
                "awards:11:16..31",
            ]);
        });

        test("a pruned block is reported as unprovable rather than dropped", async () => {
            const { chain } = fakeChain({
                blocks: [10],
                roots: [root(10)],
                proofs: { 10: { success: false, value: { type: "AwardsPruned" } } },
                trees: [10],
            });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            // One entry for the whole block: its credit count went with the awards.
            expect(result.value.credits).toEqual([
                {
                    hash: null,
                    awardBlock: 10,
                    awardedAt: 1_700_000_010,
                    gameIndex: 7,
                    leafIndex: null,
                    state: "unprovable",
                },
            ]);
        });

        test("a past block with no root and no awards is unprovable, not dropped", async () => {
            const { chain } = fakeChain({ blocks: [11], roots: [] });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits).toEqual([
                {
                    hash: null,
                    awardBlock: 11,
                    awardedAt: null,
                    gameIndex: null,
                    leafIndex: null,
                    state: "unprovable",
                },
            ]);
        });

        test("a block still to come is earned with no hash yet", async () => {
            const { chain } = fakeChain({ blocks: [PEOPLE.number + 5], roots: [] });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits[0]).toMatchObject({ hash: null, state: "earned" });
        });

        test("a proof error that is an integrity failure lands on the err channel", async () => {
            const { chain } = fakeChain({
                blocks: [10],
                roots: [root(10)],
                proofs: { 10: { success: false, value: { type: "RootMismatch" } } },
            });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(false);
        });

        test("newest award block first", async () => {
            const { chain } = fakeChain({
                blocks: [10, 12],
                roots: [root(10)],
                proofs: { 10: proof([1]) },
                awards: { 12: [{ claimant: key, credit: h(9) }] },
                trees: [10],
            });
            const result = await getCredits(chain, { claimant });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits.map((c) => c.awardBlock)).toEqual([12, 10]);
        });

        test("a person alias is keyed as Person and matched case-insensitively", async () => {
            const alias = `0x${"ab".repeat(32)}`;
            const { chain } = fakeChain({
                blocks: [11],
                roots: [],
                awards: {
                    11: [
                        {
                            claimant: {
                                type: "Person",
                                value: alias.toUpperCase().replace("0X", "0x"),
                            },
                            credit: h(3),
                        },
                    ],
                },
            });
            const result = await getCredits(chain, { claimant: { tag: "Person", alias } });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.credits.map((c) => c.hash)).toEqual([h(3)]);
        });

        test("an aborted signal lands on the err channel before any read", async () => {
            const { chain, calls } = fakeChain({ blocks: [10] });
            const controller = new AbortController();
            controller.abort();
            const result = await getCredits(chain, { claimant, signal: controller.signal });
            expect(result.ok).toBe(false);
            expect(calls).toEqual([]);
        });
    });
}
