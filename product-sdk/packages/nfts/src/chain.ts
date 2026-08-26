// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Asset Hub surface these reads need, and the block pinning they share.
 *
 * Deliberately structural rather than a pinned descriptor, the same approach as
 * `IndividualityChain` in `@parity/product-sdk-individuality` and for the same
 * reason: the SDK should not pin a genesis hash to read a catalogue. Anything
 * exposing these five storage entries **and** the raw client's
 * `getFinalizedBlock` satisfies it — a real
 * `ChainClient<{ assetHub: paseo_asset_hub }>`, a future deployment, or a
 * hand-rolled test double.
 *
 * **Fidelity is checked at compile time, from the umbrella package.**
 * `packages/sdk/src/nfts/contract.test.ts` asserts that a real `getChainAPI`
 * client still satisfies this type, so a descriptor regeneration that changes an
 * entry fails `pnpm typecheck`. The guard cannot live here: inside this package
 * the same assertion is vacuous, because the descriptor types do not fully
 * resolve through this package's dependency graph.
 *
 * Written with method shorthand on purpose: the parameter bivariance that gives
 * is what lets the real PAPI signatures satisfy the loosened key types.
 *
 * **Not every supported network carries these pallets.** `devnet-asset-hub` has
 * neither `Scarcity` nor `NftClaims`, so an e2e spec against the devnet preset
 * cannot exercise any of this, and a read against it fails with
 * {@link NftsChainEntryError}.
 *
 * Matched by hand on 2026-08-25 against live `next-asset-hub-paseo`
 * spec 2000036 (`dot inspect`), whose runtime code hash is the one
 * `descriptors/chains/paseo-asset-hub/.papi/polkadot-api.json` pins:
 *
 * ```
 * Scarcity.Collections          map u32           -> { owner, pending_owner, next_item_index, item_count, metadata_count, ... }
 * Scarcity.ItemDefs             map (u32, u32)    -> { supply, live_supply, metadata_count, deposit }
 * Scarcity.CollectionMetadata   map (u32, Vec<u8>)      -> { value, deposit }
 * Scarcity.ItemMetadata         map (u32, u32, Vec<u8>) -> { value, deposit }
 * NftClaims.CollectionMinters   map u32           -> { owner, selection: Random | Contract(H160) }
 * ```
 *
 * `ItemDefs` is the one worth recording. `dot inspect` renders its key as
 * `[u32; 2]`, which reads like a single array-typed key that could not be
 * prefix-scanned — that rendering is wrong. The raw storage key for `[0, 0]` is
 * two Twox64Concat segments (`…b4def25cfda6ef3a00000000` twice), so it is a
 * genuine two-key map and `getEntries(collection)` scans one collection rather
 * than dumping the whole map. Verified against live state via
 * `rpc.state_getKeys`.
 */
import type { FinalizedSnapshot, RawCollection, RawItemDef, RawMetadataEntry } from "./types.js";
import type { RawBytes, RawMinter, ReadAt } from "./types.js";

/** One `getEntries` row: the keys that were not fixed by the query, and the value. */
export interface Entry<Keys extends unknown[], Value> {
    keyArgs: Keys;
    value: Value;
}

/**
 * The client these reads take: five storage entries, and the raw client they pin
 * a block with.
 *
 * A client from `getChainAPI(...)` or
 * `createChainClient({ chains: { assetHub } })` satisfies it whole. A `TypedApi`
 * on its own does not, however complete its `query` surface is: every read pins
 * a finalized block before it touches storage, and only the raw client answers
 * for that.
 */
export interface NftsChain {
    assetHub: {
        query: {
            Scarcity: {
                Collections: {
                    getValue(
                        collection: number,
                        options: ReadAt,
                    ): Promise<RawCollection | undefined>;
                };
                /**
                 * A two-key map, so this scans one collection. See the note on
                 * the module doc before "simplifying" it to a full dump.
                 */
                ItemDefs: {
                    getEntries(
                        collection: number,
                        options: ReadAt,
                    ): Promise<Array<Entry<[number, number], RawItemDef>>>;
                };
                CollectionMetadata: {
                    getEntries(
                        collection: number,
                        options: ReadAt,
                    ): Promise<Array<Entry<[number, RawBytes], RawMetadataEntry>>>;
                };
                /**
                 * Scanned by collection rather than per item: one round trip
                 * brings back every key of every item, which is what keeps a
                 * catalogue read at four reads regardless of how many items it
                 * holds.
                 */
                ItemMetadata: {
                    getEntries(
                        collection: number,
                        options: ReadAt,
                    ): Promise<Array<Entry<[number, number, RawBytes], RawMetadataEntry>>>;
                };
            };
            NftClaims: {
                /**
                 * Dumped whole, deliberately. This map *is* the registry of
                 * claimable collections — "a collection with no entry cannot be
                 * claimed into" — so it is small by design and there is no
                 * prefix to scan by.
                 */
                CollectionMinters: {
                    getEntries(options: ReadAt): Promise<Array<Entry<[number], RawMinter>>>;
                };
            };
        };
    };
    raw: {
        assetHub: {
            getFinalizedBlock(): Promise<{ hash: string; number: number }>;
        };
    };
}

/**
 * Pin the block a read addresses.
 *
 * Every value in one result comes from the same block: a catalogue read pulls
 * item definitions and three metadata layers separately, and reading them a
 * block apart could return a catalogue the chain was never in — an item whose
 * definition is gone but whose metadata is not, or the reverse.
 *
 * The abort check lives here because `getFinalizedBlock` takes no options and so
 * cannot carry a signal itself — without it an already-cancelled read would
 * still cost a round trip.
 */
export async function pinBlock(
    chain: NftsChain,
    signal: AbortSignal | undefined,
): Promise<FinalizedSnapshot> {
    signal?.throwIfAborted();
    const block = await chain.raw.assetHub.getFinalizedBlock();
    return { blockHash: block.hash, blockNumber: block.number };
}

export function readAt(snapshot: FinalizedSnapshot, signal: AbortSignal | undefined): ReadAt {
    return { at: snapshot.blockHash, signal };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const BLOCK = { hash: `0x${"55".repeat(32)}`, number: 77 };

    function fakeChain() {
        let fetches = 0;
        const chain = {
            raw: {
                assetHub: {
                    getFinalizedBlock: async () => {
                        fetches += 1;
                        return BLOCK;
                    },
                },
            },
        } as NftsChain;
        return { chain, fetches: () => fetches };
    }

    describe("pinBlock", () => {
        test("pins the finalized block", async () => {
            const { chain } = fakeChain();
            expect(await pinBlock(chain, undefined)).toEqual({
                blockHash: BLOCK.hash,
                blockNumber: BLOCK.number,
            });
        });

        test("an aborted signal throws before any round trip", async () => {
            const { chain, fetches } = fakeChain();
            const controller = new AbortController();
            controller.abort();
            await expect(pinBlock(chain, controller.signal)).rejects.toThrow();
            expect(fetches()).toBe(0);
        });
    });

    describe("readAt", () => {
        test("addresses the snapshot's hash and carries the signal", () => {
            const signal = new AbortController().signal;
            const snapshot = { blockHash: BLOCK.hash, blockNumber: BLOCK.number };
            expect(readAt(snapshot, signal)).toEqual({ at: BLOCK.hash, signal });
        });
    });
}
