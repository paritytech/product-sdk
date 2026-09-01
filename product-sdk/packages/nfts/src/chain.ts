// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Asset Hub surface these reads need, and the block pinning they share.
 *
 * Deliberately structural rather than a pinned descriptor, the same approach as
 * `IndividualityChain` in `@parity/product-sdk-individuality` and for the same
 * reason: the SDK should not pin a genesis hash to read a catalogue. Anything
 * exposing these six storage entries **and** the raw client's
 * `getFinalizedBlock` satisfies it — a real
 * `ChainClient<{ assetHub: paseo_asset_hub }>`, a future deployment, or a
 * hand-rolled test double.
 *
 * **Fidelity is checked at compile time, from `@parity/product-sdk`.**
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
 * Scarcity.NextCollectionId     value             -> u32   (exclusive end of the id space)
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
 *
 * # What a multi-key read actually costs
 *
 * **`getValues` is one storage operation per key, not one per call.** PAPI
 * implements it as `Promise.all(keys.map(getValue))` (`polkadot-api@2.1.6`,
 * `dist/src/storage.js`), and each `getValue` opens its own
 * `chainHead_v1_storage` operation. So a page of `limit` entries issues on the
 * order of `limit` concurrent operations — not one request carrying `limit`
 * keys. They are pipelined over a single connection, repeated keys collapse in
 * the client's stream cache, and a node that will not accept more concurrent
 * operations answers `limitReached`, which PAPI re-queues rather than failing
 * (`observable-client`'s `operationLimitRecovery`). A large page therefore costs
 * latency, not a broken read.
 *
 * Two things follow, and the docs below are written to them. Every "one read"
 * claim about an exact-key lookup is a claim about **bytes** — that is the axis
 * where naming keys beats scanning a prefix, and it is the axis that scales with
 * the chain. And {@link MAX_PAGE_LIMIT} bounds operations as much as bytes:
 * `limit` is how many the call opens. `getEntries` is the genuinely
 * single-operation read here, and the one whose bytes scale with the collection.
 */
import type { FinalizedSnapshot, RawCollection, RawItemDef, RawMetadataEntry } from "./types.js";
import type { RawBytes, RawMinter, ReadAt } from "./types.js";

/** One `getEntries` row: the keys that were not fixed by the query, and the value. */
export interface Entry<Keys extends unknown[], Value> {
    keyArgs: Keys;
    value: Value;
}

/**
 * The client these reads take: six storage entries, and the raw client they pin
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
                /**
                 * The exclusive upper bound of the collection id space.
                 *
                 * `create_collection` takes no id — the runtime allocates from
                 * this counter — and `delete_collection` documents that "deleted
                 * collection identifiers are never reused". So ids run
                 * sequentially from 0, the space is `[0, NextCollectionId)`, and
                 * one unkeyed read bounds it. That is what makes an id window a
                 * page rather than a guess.
                 */
                NextCollectionId: {
                    getValue(options: ReadAt): Promise<number>;
                };
                Collections: {
                    getValue(
                        collection: number,
                        options: ReadAt,
                    ): Promise<RawCollection | undefined>;
                    /**
                     * Many records for keys known up front, in the order they
                     * were given, `undefined` where a record is missing.
                     *
                     * What the claimable read joins its registry against: the
                     * ids come from `CollectionMinters`, so the whole window is
                     * asked for at once rather than an id at a time. "At once"
                     * is concurrency, not batching — see the module doc.
                     */
                    getValues(
                        keys: Array<[number]>,
                        options: ReadAt,
                    ): Promise<Array<RawCollection | undefined>>;
                };
                /**
                 * A two-key map, read by exact `(collection, item)` key so a
                 * catalogue page fetches only its own window. See the module doc
                 * on why this is a genuine two-key map and not an array key.
                 */
                ItemDefs: {
                    /**
                     * An explicit window of item indices, asked for at once.
                     *
                     * How a catalogue page reads definitions. `delete_item`
                     * documents that item indices are never reused, so a window
                     * is a page here for the same reason it is for collection
                     * ids.
                     */
                    getValues(
                        keys: Array<[number, number]>,
                        options: ReadAt,
                    ): Promise<Array<RawItemDef | undefined>>;
                };
                /**
                 * Read two ways, because the two callers want different slices.
                 *
                 * A catalogue read wants one collection's defaults, so it scans by
                 * prefix. A listing page wants the `name` of specific collections,
                 * which it asks for by exact key. Both are the same descriptor
                 * whitelist entry.
                 */
                CollectionMetadata: {
                    getEntries(
                        collection: number,
                        options: ReadAt,
                    ): Promise<Array<Entry<[number, RawBytes], RawMetadataEntry>>>;
                    /**
                     * Exact `(collection, key)` lookups, in the order given.
                     *
                     * How a page reads names: exactly the rows wanted, rather
                     * than a dump that carries every key of every collection
                     * when only `name` is asked for. What that saves is bytes;
                     * the operations scale with the page either way, per the
                     * module doc.
                     *
                     * The key is a plain `Uint8Array`, not a PAPI `Binary` —
                     * PAPI 2.x generates `[number, Uint8Array]` for this
                     * `Vec<u8>` key, the same split {@link RawBytes} exists for.
                     * So this needs no `polkadot-api` dependency.
                     */
                    getValues(
                        keys: Array<[number, Uint8Array]>,
                        options: ReadAt,
                    ): Promise<Array<RawMetadataEntry | undefined>>;
                };
                /**
                 * Read both ways. A page asks for the keys it can name by exact
                 * key; `attributes: true` scans one collection instead, because the
                 * open bag's keys cannot be named in advance.
                 */
                ItemMetadata: {
                    getEntries(
                        collection: number,
                        options: ReadAt,
                    ): Promise<Array<Entry<[number, number, RawBytes], RawMetadataEntry>>>;
                    /**
                     * Exact `(collection, item, key)` lookups, in the order given.
                     *
                     * This is what makes a catalogue page affordable. The entry is
                     * a three-key map, so the typed keys of a whole window can be
                     * named and fetched together — where the open `attributes`
                     * bag, whose keys are not known in advance, would need a
                     * prefix scan per item. That asymmetry is why a page carries
                     * typed fields and not the bag. What it buys is bytes
                     * proportional to the page; the operations still scale with
                     * it, three per item — see the module doc.
                     */
                    getValues(
                        keys: Array<[number, number, Uint8Array]>,
                        options: ReadAt,
                    ): Promise<Array<RawMetadataEntry | undefined>>;
                };
            };
            NftClaims: {
                /**
                 * The registry: "a collection with no entry cannot be claimed
                 * into". Keyed by collection id, so a page probes it over a window
                 * of ids rather than dumping it.
                 */
                CollectionMinters: {
                    /**
                     * Keyed by collection id, so a page fills in `selection` for
                     * its window without dumping the registry.
                     */
                    getValues(
                        keys: Array<[number]>,
                        options: ReadAt,
                    ): Promise<Array<RawMinter | undefined>>;
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
 * item definitions and two metadata layers separately, and reading them a
 * block apart could return a catalogue the chain was never in — an item whose
 * definition is gone but whose metadata is not, or the reverse.
 *
 * The abort check lives here because `getFinalizedBlock` takes no options and so
 * cannot carry a signal itself — without it an already-cancelled read would
 * still cost a round trip.
 *
 * Pass `given` to address a block a caller already has. Two reads pin their own
 * blocks by default, which is right for two unrelated questions and wrong for
 * one question asked in pages: a paged walk over its own snapshots is not a
 * walk of any single chain state.
 */
export async function pinBlock(
    chain: NftsChain,
    signal: AbortSignal | undefined,
    given?: FinalizedSnapshot,
): Promise<FinalizedSnapshot> {
    signal?.throwIfAborted();
    // A caller that already has a snapshot is joining it rather than opening a
    // new one — several reads, or several pages of one read, addressing a single
    // block. It costs no round trip, and the abort check above still applies.
    if (given !== undefined) return given;
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

    describe("pinBlock with a given snapshot", () => {
        test("joins it without a round trip", async () => {
            const { chain, fetches } = fakeChain();
            const given = { blockHash: `0x${"aa".repeat(32)}`, blockNumber: 12 };
            expect(await pinBlock(chain, undefined, given)).toEqual(given);
            expect(fetches()).toBe(0);
        });

        test("an aborted signal still throws before anything else", async () => {
            const { chain } = fakeChain();
            const controller = new AbortController();
            controller.abort();
            await expect(
                pinBlock(chain, controller.signal, {
                    blockHash: BLOCK.hash,
                    blockNumber: BLOCK.number,
                }),
            ).rejects.toThrow();
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
