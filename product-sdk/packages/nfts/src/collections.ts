// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The two collection-listing reads, and the one distinction between them.
 *
 * There is one kind of collection on chain. `Scarcity.Collections` says a
 * collection exists; `NftClaims.CollectionMinters` is a *second pallet's* map
 * whose entry means the owner opted in via `set_collection_minter`, and which
 * records how a claim picks an item. Its keys are a subset of the first map's.
 *
 * - `getClaimableCollections` — the subset. Driven by the registry, so every
 *   entry has a `selection`. What a picker wants.
 * - `getCollections` — the superset. Driven by the records, with `selection`
 *   `null` where no registration exists. What a browser or an audit wants.
 *
 * How much the distinction removes is per deployment: one carries six
 * collections and registers one, another registers most of what it carries, so
 * neither read can be assumed to stand in for the other.
 *
 * Both are named for what they return rather than for the pallet they read. A
 * single collection, registered or not, comes from `getCollectionItems` — that
 * read applies no registry filter either.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { pinBlock, readAt, type NftsChain } from "./chain.js";
import { matchChainEntryError, NftsDecodeError, ProductNftsError } from "./errors.js";
import { decodeMetadataKey, decodeMetadataValue } from "./metadata.js";
import type { ClaimableCollection, CollectionSummary, ItemSelection, RawMinter } from "./types.js";
import type { FinalizedSnapshot, ReadAt } from "./types.js";

/** What one `getClaimableCollections` call returns. */
export interface ClaimableCollectionsResult {
    at: FinalizedSnapshot;
    collections: ClaimableCollection[];
}

export interface GetClaimableCollectionsOptions {
    /**
     * Forwarded into every underlying pull, so an aborted caller stops the whole
     * batch. No deadline is applied here — that belongs to the caller.
     */
    signal?: AbortSignal;
}

/** What one `getCollections` call returns. */
export interface CollectionsResult {
    at: FinalizedSnapshot;
    collections: CollectionSummary[];
}

export interface GetCollectionsOptions {
    /** Forwarded into every underlying pull, as with the claimable read. */
    signal?: AbortSignal;
}

/**
 * `Random | Contract(H160)` into a tagged union.
 *
 * An unknown variant is an error rather than a passthrough: `selection` decides
 * what a claim mints, and a caller that cannot tell how would be guessing about
 * something the user is about to spend a credit on.
 */
export function toItemSelection(raw: RawMinter["selection"]): ItemSelection {
    if (raw.type === "Random") return { tag: "Random" };
    if (raw.type === "Contract") {
        const address = raw.value;
        if (typeof address === "string") return { tag: "Contract", address };
        if (typeof (address as { asHex?: unknown })?.asHex === "function") {
            return { tag: "Contract", address: (address as { asHex(): string }).asHex() };
        }
        throw new NftsDecodeError("Contract selection carries no readable H160");
    }
    throw new NftsDecodeError("unknown ItemSelection variant");
}

/**
 * Read every claimable collection, from one pinned finalized block.
 *
 * Two reads plus one per registered collection: the minter registry, then each
 * collection's record and its metadata. The per-collection reads run
 * concurrently, and the registry is small by construction, so this stays a
 * handful of round trips.
 *
 * Returns a `Result`, per the SDK-wide error model. A collection registered for
 * claims whose `Scarcity.Collections` record is missing is **not** an error: it
 * comes back with `itemCount` and `owner` `null`, because the caller can still
 * render it and the inconsistency is the chain's, not the read's.
 *
 * Names come from the `Scarcity.CollectionMetadata` storage layer.
 *
 * @example
 * ```ts
 * const chain = await getChainAPI("paseo");
 * const result = await getClaimableCollections(chain);
 * if (result.ok) {
 *     for (const collection of result.value.collections) {
 *         console.log(collection.id, collection.name ?? "(unnamed)", collection.itemCount);
 *     }
 * }
 * ```
 */
export async function getClaimableCollections(
    chain: NftsChain,
    options: GetClaimableCollectionsOptions = {},
): Promise<Result<ClaimableCollectionsResult, ProductNftsError>> {
    try {
        const { signal } = options;
        const snapshot = await pinBlock(chain, signal);
        const at = readAt(snapshot, signal);
        const query = chain.assetHub.query;

        const minters = await query.NftClaims.CollectionMinters.getEntries(at);

        const collections = await Promise.all(
            minters.map(async (minter): Promise<ClaimableCollection> => {
                const id = minter.keyArgs[0];
                const [record, name] = await Promise.all([
                    query.Scarcity.Collections.getValue(id, at),
                    readName(query, id, at),
                ]);

                return {
                    id,
                    name,
                    selection: toItemSelection(minter.value.selection),
                    itemCount: record?.item_count ?? null,
                    owner: record?.owner ?? null,
                };
            }),
        );

        // Ascending by id: `getEntries` order follows the storage hash, which is
        // stable but arbitrary, and a picker should not reorder between reads.
        collections.sort((a, b) => a.id - b.id);

        return ok({ at: snapshot, collections });
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

/** The `name` metadata of one collection, or `null` when it sets none. */
async function readName(
    query: NftsChain["assetHub"]["query"],
    id: number,
    at: ReadAt,
): Promise<string | null> {
    const metadata = await query.Scarcity.CollectionMetadata.getEntries(id, at);
    const name = metadata.find((e) => decodeMetadataKey(e.keyArgs[1]) === "name");
    return name === undefined ? null : decodeMetadataValue(name.value.value);
}

/**
 * Read every collection on chain, claimable or not, from one pinned finalized
 * block.
 *
 * The superset {@link getClaimableCollections} filters. Two dumps plus one
 * metadata read per collection: `Scarcity.Collections` for the records,
 * `NftClaims.CollectionMinters` to fill in `selection`, then each collection's
 * name. `selection` is `null` for a collection that accepts no claims.
 *
 * **Prefer {@link getClaimableCollections} for a picker.** This read pays
 * metadata for every collection to return the ones a claim cannot use — on a
 * deployment carrying six and registering one, six metadata reads for one usable
 * entry. Reach for this when browsing or auditing the chain, not when spending a
 * credit.
 *
 * A minter entry whose `Scarcity.Collections` record is missing cannot appear
 * here, because this enumerates the records. {@link getClaimableCollections}
 * reports that case with null fields.
 *
 * @example
 * ```ts
 * const result = await getCollections(chain);
 * if (result.ok) {
 *     for (const c of result.value.collections) {
 *         console.log(c.id, c.name ?? "(unnamed)", c.selection ? "claimable" : "not claimable");
 *     }
 * }
 * ```
 */
export async function getCollections(
    chain: NftsChain,
    options: GetCollectionsOptions = {},
): Promise<Result<CollectionsResult, ProductNftsError>> {
    try {
        const { signal } = options;
        const snapshot = await pinBlock(chain, signal);
        const at = readAt(snapshot, signal);
        const query = chain.assetHub.query;

        const [records, minters] = await Promise.all([
            query.Scarcity.Collections.getEntries(at),
            query.NftClaims.CollectionMinters.getEntries(at),
        ]);

        // Built before the metadata fan-out so an unknown selection variant
        // fails the whole read rather than one collection's `selection`.
        const selections = new Map<number, ItemSelection>(
            minters.map((minter) => [minter.keyArgs[0], toItemSelection(minter.value.selection)]),
        );

        const collections = await Promise.all(
            records.map(async (record): Promise<CollectionSummary> => {
                const id = record.keyArgs[0];
                return {
                    id,
                    name: await readName(query, id, at),
                    itemCount: record.value.item_count,
                    owner: record.value.owner,
                    selection: selections.get(id) ?? null,
                };
            }),
        );

        // Ascending by id, for the same reason the claimable read sorts.
        collections.sort((a, b) => a.id - b.id);

        return ok({ at: snapshot, collections });
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const utf8 = (text: string) => new TextEncoder().encode(text);
    const BLOCK = { hash: `0x${"77".repeat(32)}`, number: 42 };

    function fakeChain(overrides: {
        minters?: Array<{ keyArgs: [number]; value: RawMinter }>;
        records?: Record<number, { owner: string; item_count: number }>;
        metadata?: Record<number, Array<[string, string]>>;
    }) {
        const calls: string[] = [];
        const chain = {
            assetHub: {
                query: {
                    NftClaims: {
                        CollectionMinters: {
                            getEntries: async () => {
                                calls.push("minters");
                                return overrides.minters ?? [];
                            },
                        },
                    },
                    Scarcity: {
                        Collections: {
                            getValue: async (id: number) => {
                                calls.push(`record:${id}`);
                                return overrides.records?.[id];
                            },
                            getEntries: async () => {
                                calls.push("records");
                                return Object.entries(overrides.records ?? {}).map(
                                    ([id, value]) => ({ keyArgs: [Number(id)], value }),
                                );
                            },
                        },
                        CollectionMetadata: {
                            getEntries: async (id: number) => {
                                calls.push(`metadata:${id}`);
                                return (overrides.metadata?.[id] ?? []).map(([key, value]) => ({
                                    keyArgs: [id, utf8(key)] as [number, Uint8Array],
                                    value: { value: utf8(value) },
                                }));
                            },
                        },
                    },
                },
            },
            raw: { assetHub: { getFinalizedBlock: async () => BLOCK } },
        } as unknown as NftsChain;
        return { chain, calls };
    }

    describe("toItemSelection", () => {
        test("Random", () => {
            expect(toItemSelection({ type: "Random" })).toEqual({ tag: "Random" });
        });

        test("Contract with a hex string", () => {
            expect(toItemSelection({ type: "Contract", value: "0xabc" })).toEqual({
                tag: "Contract",
                address: "0xabc",
            });
        });

        test("Contract with a FixedSizeBinary", () => {
            expect(toItemSelection({ type: "Contract", value: { asHex: () => "0xdef" } })).toEqual({
                tag: "Contract",
                address: "0xdef",
            });
        });

        test("an unknown variant is a decode error", () => {
            expect(() => toItemSelection({ type: "Auction" })).toThrow(NftsDecodeError);
        });

        test("a Contract with no readable address is a decode error", () => {
            expect(() => toItemSelection({ type: "Contract", value: 7 })).toThrow(NftsDecodeError);
        });
    });

    describe("getClaimableCollections", () => {
        test("returns only registered collections, joined to their record", async () => {
            // The live Paseo Next shape: six collections exist, one is registered.
            const { chain } = fakeChain({
                minters: [
                    { keyArgs: [0], value: { owner: "1513Gd7", selection: { type: "Random" } } },
                ],
                records: {
                    0: { owner: "1513Gd7", item_count: 1 },
                    1: { owner: "13EXQCr", item_count: 0 },
                },
                metadata: { 0: [["name", "One and only "]] },
            });

            const result = await getClaimableCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
            expect(result.value.collections).toEqual([
                {
                    id: 0,
                    name: "One and only ",
                    selection: { tag: "Random" },
                    itemCount: 1,
                    owner: "1513Gd7",
                },
            ]);
        });

        test("an empty registry is an empty list, not an error", async () => {
            const result = await getClaimableCollections(fakeChain({}).chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toEqual([]);
        });

        test("a registered collection with no record reports nulls", async () => {
            const { chain } = fakeChain({
                minters: [
                    { keyArgs: [4], value: { owner: "1513Gd7", selection: { type: "Random" } } },
                ],
            });
            const result = await getClaimableCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections[0]).toEqual({
                id: 4,
                name: null,
                selection: { tag: "Random" },
                itemCount: null,
                owner: null,
            });
        });

        test("a collection with no name metadata reports a null name", async () => {
            const { chain } = fakeChain({
                minters: [{ keyArgs: [0], value: { owner: "o", selection: { type: "Random" } } }],
                records: { 0: { owner: "o", item_count: 0 } },
                metadata: { 0: [["palette", "moss"]] },
            });
            const result = await getClaimableCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections[0]?.name).toBeNull();
        });

        test("sorts ascending by id whatever order storage returns", async () => {
            const minter = (id: number) => ({
                keyArgs: [id] as [number],
                value: { owner: "o", selection: { type: "Random" } },
            });
            const { chain } = fakeChain({ minters: [minter(5), minter(0), minter(2)] });
            const result = await getClaimableCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections.map((c) => c.id)).toEqual([0, 2, 5]);
        });

        test("reads every collection at the pinned block", async () => {
            const { chain, calls } = fakeChain({
                minters: [{ keyArgs: [0], value: { owner: "o", selection: { type: "Random" } } }],
            });
            await getClaimableCollections(chain);
            expect(calls).toContain("record:0");
            expect(calls).toContain("metadata:0");
        });

        test("a failing read lands on the err channel", async () => {
            const chain = {
                assetHub: {
                    query: {
                        NftClaims: {
                            CollectionMinters: {
                                getEntries: async () => {
                                    throw new Error("node unreachable");
                                },
                            },
                        },
                    },
                },
                raw: { assetHub: { getFinalizedBlock: async () => BLOCK } },
            } as unknown as NftsChain;

            const result = await getClaimableCollections(chain);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(ProductNftsError);
        });

        test("an aborted signal lands on the err channel", async () => {
            const controller = new AbortController();
            controller.abort();
            const result = await getClaimableCollections(fakeChain({}).chain, {
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
        });

        test("an unknown selection variant lands on the err channel", async () => {
            const { chain } = fakeChain({
                minters: [{ keyArgs: [0], value: { owner: "o", selection: { type: "Auction" } } }],
            });
            const result = await getClaimableCollections(chain);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });
    });

    describe("getCollections", () => {
        // The live Paseo Next shape, reduced: several collections exist, one is
        // registered. This is the case the two reads disagree about.
        const sixCarriedOneRegistered = () =>
            fakeChain({
                minters: [
                    { keyArgs: [0], value: { owner: "1513Gd7", selection: { type: "Random" } } },
                ],
                records: {
                    0: { owner: "1513Gd7", item_count: 1 },
                    1: { owner: "13EXQCr", item_count: 0 },
                },
                metadata: { 0: [["name", "One and only "]], 1: [["name", "Unregistered"]] },
            });

        test("returns collections that accept no claims, with a null selection", async () => {
            const result = await getCollections(sixCarriedOneRegistered().chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
            expect(result.value.collections).toEqual([
                {
                    id: 0,
                    name: "One and only ",
                    itemCount: 1,
                    owner: "1513Gd7",
                    selection: { tag: "Random" },
                },
                { id: 1, name: "Unregistered", itemCount: 0, owner: "13EXQCr", selection: null },
            ]);
        });

        test("is a superset of the claimable read", async () => {
            const all = await getCollections(sixCarriedOneRegistered().chain);
            const claimable = await getClaimableCollections(sixCarriedOneRegistered().chain);
            expect(all.ok && claimable.ok).toBe(true);
            if (!all.ok || !claimable.ok) return;

            const claimableIds = claimable.value.collections.map((c) => c.id);
            const withSelection = all.value.collections
                .filter((c) => c.selection !== null)
                .map((c) => c.id);
            expect(withSelection).toEqual(claimableIds);
            expect(all.value.collections.length).toBeGreaterThan(claimableIds.length);
        });

        test("an empty chain is an empty list, not an error", async () => {
            const result = await getCollections(fakeChain({}).chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toEqual([]);
        });

        test("a minter entry with no record cannot appear", async () => {
            // The mirror of the claimable read's null-fields case: that read
            // reports id 4, this one cannot see it at all.
            const { chain } = fakeChain({
                minters: [{ keyArgs: [4], value: { owner: "o", selection: { type: "Random" } } }],
            });
            const result = await getCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toEqual([]);
        });

        test("a collection with no name metadata reports a null name", async () => {
            const { chain } = fakeChain({ records: { 3: { owner: "o", item_count: 2 } } });
            const result = await getCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections[0]?.name).toBeNull();
        });

        test("sorts ascending by id whatever order storage returns", async () => {
            const { chain } = fakeChain({
                records: {
                    5: { owner: "o", item_count: 0 },
                    0: { owner: "o", item_count: 0 },
                    2: { owner: "o", item_count: 0 },
                },
            });
            const result = await getCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections.map((c) => c.id)).toEqual([0, 2, 5]);
        });

        test("dumps both maps at the pinned block", async () => {
            const { chain, calls } = sixCarriedOneRegistered();
            await getCollections(chain);
            expect(calls).toContain("records");
            expect(calls).toContain("minters");
            expect(calls).toContain("metadata:1");
        });

        test("an unknown selection variant fails the whole read", async () => {
            // Not just that collection's `selection`: a caller cannot tell what a
            // claim would mint, and silently reporting `null` would read as "not
            // claimable", which is the opposite of the truth.
            const { chain } = fakeChain({
                minters: [{ keyArgs: [0], value: { owner: "o", selection: { type: "Auction" } } }],
                records: { 0: { owner: "o", item_count: 1 } },
            });
            const result = await getCollections(chain);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });

        test("an aborted signal lands on the err channel", async () => {
            const controller = new AbortController();
            controller.abort();
            const result = await getCollections(fakeChain({}).chain, {
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
        });

        test("a failing read lands on the err channel", async () => {
            const chain = {
                assetHub: {
                    query: {
                        Scarcity: {
                            Collections: {
                                getEntries: async () => {
                                    throw new Error("node unreachable");
                                },
                            },
                        },
                        NftClaims: { CollectionMinters: { getEntries: async () => [] } },
                    },
                },
                raw: { assetHub: { getFinalizedBlock: async () => BLOCK } },
            } as unknown as NftsChain;

            const result = await getCollections(chain);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(ProductNftsError);
        });
    });
}
