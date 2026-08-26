// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `getCollectionItems` — a collection's full item catalogue.
 *
 * Four reads, whatever the item count: the collection record, every item
 * definition in the collection, every item metadata entry in the collection, and
 * the collection's own metadata defaults. The middle two are prefix scans, which
 * is what keeps this flat rather than one round trip per item.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { pinBlock, readAt, type Entry, type NftsChain } from "./chain.js";
import { matchChainEntryError, NftsChainEntryError, ProductNftsError } from "./errors.js";
import { decodeMetadataKey, decodeMetadataValue, imageRefFrom, mergeMetadata } from "./metadata.js";
import type { CollectionItem, CollectionItemsResult, RawBytes, RawMetadataEntry } from "./types.js";

export interface GetCollectionItemsOptions {
    /** Forwarded into every underlying pull, so an aborted caller stops the batch. */
    signal?: AbortSignal;
}

/** Group `ItemMetadata` rows by item index, keeping the raw bytes. */
function byItem(
    entries: Array<Entry<[number, number, RawBytes], RawMetadataEntry>>,
): Map<number, Record<string, RawBytes>> {
    const grouped = new Map<number, Record<string, RawBytes>>();
    for (const entry of entries) {
        const index = entry.keyArgs[1];
        const bag = grouped.get(index) ?? {};
        bag[decodeMetadataKey(entry.keyArgs[2])] = entry.value.value;
        grouped.set(index, bag);
    }
    return grouped;
}

/** `CollectionMetadata` rows into one raw bag. */
function collectionBag(
    entries: Array<Entry<[number, RawBytes], RawMetadataEntry>>,
): Record<string, RawBytes> {
    const bag: Record<string, RawBytes> = {};
    for (const entry of entries) {
        bag[decodeMetadataKey(entry.keyArgs[1])] = entry.value.value;
    }
    return bag;
}

function decodeBag(raw: Record<string, RawBytes>): Record<string, string> {
    const decoded: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        decoded[key] = decodeMetadataValue(value);
    }
    return decoded;
}

/**
 * Read every item defined in a collection, with its display metadata merged in.
 *
 * Metadata resolves in two layers — the collection's defaults underneath, the
 * item's overrides on top — which is what `ItemMetadata`'s "override collection
 * defaults for the same key" means on chain. `InstanceMetadata` is the third
 * layer and is deliberately not consulted: it keys on an instance id, so it
 * describes a minted NFT rather than a catalogue entry.
 *
 * Returns a `Result`. A collection nobody created is **not** an error — it
 * resolves to `ok({ tag: "NotFound", … })`, because the chain was asked and
 * answered. An existing collection with no items resolves to `Found` with an
 * empty `items`.
 *
 * **`transferability` is not returned.** The field in the original spec traces
 * to `pallet_nfts`' `CollectionSetting::TransferableItems` and has no source in
 * `Scarcity`: not in `ItemDefs`, and not in any metadata key the live chain
 * carries. It is left out rather than invented.
 *
 * @example
 * ```ts
 * const chain = await getChainAPI("paseo");
 * const result = await getCollectionItems(chain, 0);
 * if (result.ok && result.value.tag === "Found") {
 *     for (const item of result.value.collection.items) {
 *         console.log(item.index, item.name, item.rarity, `${item.liveSupply}/${item.supply}`);
 *     }
 * }
 * ```
 */
export async function getCollectionItems(
    chain: NftsChain,
    id: number,
    options: GetCollectionItemsOptions = {},
): Promise<Result<CollectionItemsResult, ProductNftsError>> {
    try {
        const { signal } = options;
        const snapshot = await pinBlock(chain, signal);
        const at = readAt(snapshot, signal);
        const query = chain.assetHub.query;

        const [record, defs, itemMetadata, collectionMetadata] = await Promise.all([
            query.Scarcity.Collections.getValue(id, at),
            query.Scarcity.ItemDefs.getEntries(id, at),
            query.Scarcity.ItemMetadata.getEntries(id, at),
            query.Scarcity.CollectionMetadata.getEntries(id, at),
        ]);

        if (record === undefined) {
            return ok({ tag: "NotFound", at: snapshot, id });
        }

        const defaults = collectionBag(collectionMetadata);
        const decodedDefaults = decodeBag(defaults);
        const perItem = byItem(itemMetadata);

        const items: CollectionItem[] = defs
            .map((def): CollectionItem => {
                const index = def.keyArgs[1];
                const overrides = perItem.get(index) ?? {};
                const attributes = mergeMetadata(decodedDefaults, decodeBag(overrides));

                return {
                    index,
                    supply: def.value.supply,
                    liveSupply: def.value.live_supply,
                    name: attributes.name ?? null,
                    imageRef: imageRefFrom([defaults, overrides]),
                    rarity: attributes.rarity ?? null,
                    attributes,
                };
            })
            .sort((a, b) => a.index - b.index);

        return ok({
            tag: "Found",
            at: snapshot,
            collection: {
                id,
                name: decodedDefaults.name ?? null,
                itemCount: record.item_count,
                items,
            },
        });
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const utf8 = (text: string) => new TextEncoder().encode(text);
    const BLOCK = { hash: `0x${"88".repeat(32)}`, number: 99 };
    const DIGEST = new Uint8Array(32).fill(0xab);

    type Bag = Array<[string, Uint8Array]>;

    function fakeChain(state: {
        record?: { owner: string; item_count: number };
        defs?: Array<[number, { supply: number; live_supply: number }]>;
        itemMetadata?: Array<[number, Bag]>;
        collectionMetadata?: Bag;
    }) {
        const scans: string[] = [];
        const chain = {
            assetHub: {
                query: {
                    Scarcity: {
                        Collections: { getValue: async () => state.record },
                        ItemDefs: {
                            getEntries: async (collection: number) => {
                                scans.push(`defs:${collection}`);
                                return (state.defs ?? []).map(([index, value]) => ({
                                    keyArgs: [collection, index] as [number, number],
                                    value,
                                }));
                            },
                        },
                        ItemMetadata: {
                            getEntries: async (collection: number) => {
                                scans.push(`itemMeta:${collection}`);
                                return (state.itemMetadata ?? []).flatMap(([index, bag]) =>
                                    bag.map(([key, value]) => ({
                                        keyArgs: [collection, index, utf8(key)] as [
                                            number,
                                            number,
                                            Uint8Array,
                                        ],
                                        value: { value },
                                    })),
                                );
                            },
                        },
                        CollectionMetadata: {
                            getEntries: async (collection: number) =>
                                (state.collectionMetadata ?? []).map(([key, value]) => ({
                                    keyArgs: [collection, utf8(key)] as [number, Uint8Array],
                                    value: { value },
                                })),
                        },
                    },
                },
            },
            raw: { assetHub: { getFinalizedBlock: async () => BLOCK } },
        } as unknown as NftsChain;
        return { chain, scans };
    }

    describe("getCollectionItems", () => {
        test("reads the live collection-0 shape", async () => {
            // Exactly what Paseo Next holds: one item, six metadata keys, and a
            // collection-level name the item overrides.
            const { chain } = fakeChain({
                record: { owner: "1513Gd7", item_count: 1 },
                defs: [[0, { supply: 1, live_supply: 1 }]],
                collectionMetadata: [["name", utf8("One and only ")]],
                itemMetadata: [
                    [
                        0,
                        [
                            ["name", utf8("Hollow Beacon #0")],
                            ["palette", utf8("moss")],
                            ["image", DIGEST],
                            ["energy", utf8("21")],
                            ["style", utf8("comets")],
                            ["rarity", utf8("common")],
                        ],
                    ],
                ],
            });

            const result = await getCollectionItems(chain, 0);
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;

            const { collection } = result.value;
            expect(collection.name).toBe("One and only ");
            expect(collection.itemCount).toBe(1);
            expect(collection.items).toHaveLength(1);

            const item = collection.items[0];
            expect(item).toMatchObject({
                index: 0,
                supply: 1,
                liveSupply: 1,
                name: "Hollow Beacon #0",
                rarity: "common",
                imageRef: { hex: `0x${"ab".repeat(32)}`, text: null },
            });
            // The open schema: app-specific keys survive, and `energy` stays text.
            expect(item?.attributes).toEqual({
                name: "Hollow Beacon #0",
                palette: "moss",
                image: `0x${"ab".repeat(32)}`,
                energy: "21",
                style: "comets",
                rarity: "common",
            });
        });

        test("an item inherits collection defaults it does not override", async () => {
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 1 },
                defs: [[0, { supply: 3, live_supply: 3 }]],
                collectionMetadata: [
                    ["rarity", utf8("common")],
                    ["palette", utf8("moss")],
                ],
                itemMetadata: [[0, [["rarity", utf8("rare")]]]],
            });

            const result = await getCollectionItems(chain, 0);
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            expect(result.value.collection.items[0]?.rarity).toBe("rare");
            expect(result.value.collection.items[0]?.attributes.palette).toBe("moss");
        });

        test("a collection-level image is inherited", async () => {
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 1 },
                defs: [[0, { supply: 1, live_supply: 1 }]],
                collectionMetadata: [["image", DIGEST]],
            });
            const result = await getCollectionItems(chain, 0);
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            expect(result.value.collection.items[0]?.imageRef).toEqual({
                hex: `0x${"ab".repeat(32)}`,
                text: null,
            });
        });

        test("an image that is an ASCII CID reports both readings", async () => {
            // The other shape a deployment stores: the CID as text, not a digest.
            const cid = "bafk2bzacecjsmkthqc5ouon34ql5utgn4qfwwt23b3j5lry5d236nve27xe7m";
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 1 },
                defs: [[0, { supply: 1, live_supply: 1 }]],
                itemMetadata: [[0, [["image", utf8(cid)]]]],
            });
            const result = await getCollectionItems(chain, 0);
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            const item = result.value.collection.items[0];
            expect(item?.imageRef?.text).toBe(cid);
            expect(item?.imageRef?.hex.startsWith("0x62616")).toBe(true);
            // The bag keeps the decoded reading, as it does for every key.
            expect(item?.attributes.image).toBe(cid);
        });

        test("a missing collection is NotFound, not an error", async () => {
            const result = await getCollectionItems(fakeChain({}).chain, 9);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value).toEqual({
                tag: "NotFound",
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
                id: 9,
            });
        });

        test("an existing but empty collection is Found with no items", async () => {
            const { chain } = fakeChain({ record: { owner: "13EXQCr", item_count: 0 } });
            const result = await getCollectionItems(chain, 1);
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;
            expect(result.value.collection.items).toEqual([]);
            expect(result.value.collection.itemCount).toBe(0);
        });

        test("items come back ascending by index", async () => {
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 3 },
                defs: [
                    [7, { supply: 1, live_supply: 1 }],
                    [2, { supply: 1, live_supply: 1 }],
                    [4, { supply: 1, live_supply: 0 }],
                ],
            });
            const result = await getCollectionItems(chain, 0);
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            expect(result.value.collection.items.map((i) => i.index)).toEqual([2, 4, 7]);
        });

        test("item_count is reported as the chain has it, not recomputed", async () => {
            // The two are separate writes, so they can disagree mid-removal.
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 5 },
                defs: [[0, { supply: 1, live_supply: 1 }]],
            });
            const result = await getCollectionItems(chain, 0);
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            expect(result.value.collection.itemCount).toBe(5);
            expect(result.value.collection.items).toHaveLength(1);
        });

        test("scans by collection rather than dumping the map", async () => {
            const { chain, scans } = fakeChain({ record: { owner: "o", item_count: 0 } });
            await getCollectionItems(chain, 3);
            expect(scans).toEqual(["defs:3", "itemMeta:3"]);
        });

        test("metadata for other items does not leak across", async () => {
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 2 },
                defs: [
                    [0, { supply: 1, live_supply: 1 }],
                    [1, { supply: 1, live_supply: 1 }],
                ],
                itemMetadata: [
                    [0, [["name", utf8("first")]]],
                    [1, [["name", utf8("second")]]],
                ],
            });
            const result = await getCollectionItems(chain, 0);
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            expect(result.value.collection.items.map((i) => i.name)).toEqual(["first", "second"]);
        });

        test("a failing read lands on the err channel", async () => {
            const chain = {
                assetHub: {
                    query: {
                        Scarcity: {
                            Collections: {
                                getValue: async () => {
                                    throw new Error("node unreachable");
                                },
                            },
                            ItemDefs: { getEntries: async () => [] },
                            ItemMetadata: { getEntries: async () => [] },
                            CollectionMetadata: { getEntries: async () => [] },
                        },
                    },
                },
                raw: { assetHub: { getFinalizedBlock: async () => BLOCK } },
            } as unknown as NftsChain;

            const result = await getCollectionItems(chain, 0);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(ProductNftsError);
        });

        test("a pruned descriptor lands as NftsChainEntryError", async () => {
            // What an app whose descriptors omit an entry this read needs sees.
            const chain = {
                assetHub: {
                    query: {
                        Scarcity: {
                            Collections: { getValue: async () => ({ owner: "o", item_count: 0 }) },
                            ItemDefs: { getEntries: async () => [] },
                            ItemMetadata: { getEntries: async () => [] },
                            CollectionMetadata: {
                                getEntries: async () => {
                                    throw new Error(
                                        "Incompatible runtime entry Storage(Scarcity.CollectionMetadata)",
                                    );
                                },
                            },
                        },
                    },
                },
                raw: { assetHub: { getFinalizedBlock: async () => BLOCK } },
            } as unknown as NftsChain;

            const result = await getCollectionItems(chain, 0);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsChainEntryError);
        });

        test("an aborted signal lands on the err channel", async () => {
            const controller = new AbortController();
            controller.abort();
            const result = await getCollectionItems(fakeChain({}).chain, 0, {
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
        });
    });
}
