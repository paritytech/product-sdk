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
import { fillByIdWindow, pageBounds } from "./paging.js";
import { matchChainEntryError, NftsChainEntryError, ProductNftsError } from "./errors.js";
import {
    decodeMetadataKey,
    decodeMetadataValue,
    imageRefFrom,
    mergeMetadata,
    TYPED_KEYS,
} from "./metadata.js";
import type {
    CollectionItem,
    CollectionItemsResult,
    FinalizedSnapshot,
    RawBytes,
    RawMetadataEntry,
    ReadAt,
} from "./types.js";

/**
 * Group `ItemMetadata` rows by item index, keeping the raw bytes.
 *
 * Every bag here is `Object.create(null)`. Metadata keys are author-supplied
 * `Vec<u8>`, so a `__proto__` key on a `{}` bag would set the prototype instead
 * of an own property: `Object.entries` would then drop it, and the item would
 * silently report less than the chain holds.
 */
function byItem(
    entries: Array<Entry<[number, number, RawBytes], RawMetadataEntry>>,
): Map<number, Record<string, RawBytes>> {
    const grouped = new Map<number, Record<string, RawBytes>>();
    for (const entry of entries) {
        const index = entry.keyArgs[1];
        const bag: Record<string, RawBytes> = grouped.get(index) ?? Object.create(null);
        bag[decodeMetadataKey(entry.keyArgs[2])] = entry.value.value;
        grouped.set(index, bag);
    }
    return grouped;
}

/** `CollectionMetadata` rows into one raw bag. */
function collectionBag(
    entries: Array<Entry<[number, RawBytes], RawMetadataEntry>>,
): Record<string, RawBytes> {
    const bag: Record<string, RawBytes> = Object.create(null);
    for (const entry of entries) {
        bag[decodeMetadataKey(entry.keyArgs[1])] = entry.value.value;
    }
    return bag;
}

function decodeBag(raw: Record<string, RawBytes>): Record<string, string> {
    const decoded: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(raw)) {
        decoded[key] = decodeMetadataValue(value);
    }
    return decoded;
}

export interface GetCollectionItemsOptions {
    /**
     * How many items this page returns, defaulting to
     * {@link DEFAULT_PAGE_LIMIT} and capped at {@link MAX_PAGE_LIMIT}.
     *
     * **There is no "give me everything" here, on purpose.** Nothing on chain
     * bounds a collection: the pallet's only item ceiling is index-space
     * exhaustion — `TooManyItems` reads "the per-collection item index space is
     * exhausted", and the index is a `u32` — so a collection large enough to
     * break this read is an afternoon's work for its owner. Follow `nextId` to
     * walk the whole catalogue in bounded pieces.
     *
     * A page walks past indices whose definitions were deleted rather than coming
     * up short, so it returns exactly `limit` unless the index space runs out or a
     * heavily-pruned stretch exhausts the scan budget.
     */
    limit?: number;
    /**
     * Where the window starts, defaulting to 0.
     *
     * Take it from the previous page's `nextId`. `delete_item` documents that
     * item indices are never reused, so resuming there cannot skip or repeat an
     * item even while the collection is being written to.
     */
    fromId?: number;
    /**
     * Fill in {@link CollectionItem.attributes} — the open metadata bag —
     * defaulting to `false`.
     *
     * The typed fields (`name`, `image`, `rarity`) are keys this package can name,
     * so a page fetches them for its whole window in one exact-key read. The bag's
     * keys are open by definition, so there is nothing to ask for by name: filling
     * it means a prefix scan of **the whole collection's** item metadata. That is
     * still one read, but its bytes scale with the catalogue rather than the page,
     * which is exactly what paging is for.
     *
     * So: pass it for a collection you know is small, or when a caller genuinely
     * needs app-specific keys. Leave it off and `attributes` is `null` — "not
     * fetched", distinct from an empty bag meaning "no metadata".
     */
    attributes?: boolean;
    /**
     * Address a block a previous read already pinned, instead of pinning a new
     * one.
     *
     * Pass this when walking a catalogue: without it every page pins its own
     * finalized block, and a walk over separate snapshots is not a walk of any one
     * catalogue.
     */
    at?: FinalizedSnapshot;
    /** Forwarded into every underlying pull, so an aborted caller stops the batch. */
    signal?: AbortSignal;
}

/**
 * Read one page of a collection's item catalogue.
 *
 * Four reads per page whatever the collection holds: the collection record, its
 * metadata defaults, the item definitions in the window, and the metadata for
 * those items. Nothing here is proportional to the catalogue unless
 * `attributes: true` asks for the open bag, which no exact-key read can supply.
 *
 * Metadata resolves in two layers — the collection's defaults underneath, the
 * item's overrides on top — which is what `ItemMetadata`'s "override collection
 * defaults for the same key" means on chain. `InstanceMetadata` is the third layer
 * and is deliberately not consulted: it keys on an instance id, so it describes a
 * minted NFT rather than a catalogue entry.
 *
 * Returns a `Result`. A collection nobody created is **not** an error — it
 * resolves to `ok({ tag: "NotFound", … })`, because the chain was asked and
 * answered. An existing collection with no items resolves to `Found` with an
 * empty `items`.
 *
 * **`transferability` is not returned.** The field in the original spec traces to
 * `pallet_nfts`' `CollectionSetting::TransferableItems` and has no source in
 * `Scarcity`: not in `ItemDefs`, and not in any metadata key the live chain
 * carries. It is left out rather than invented.
 *
 * @example
 * ```ts
 * const chain = await getChainAPI("paseo");
 *
 * // One page, then the rest — `at` pins the whole walk to one block.
 * const first = await getCollectionItems(chain, 0, { limit: 100 });
 * if (!first.ok || first.value.tag !== "Found") return;
 *
 * let page = first.value;
 * const at = page.at;
 * for (;;) {
 *     for (const item of page.collection.items) {
 *         console.log(item.index, item.name, item.rarity, `${item.liveSupply}/${item.supply}`);
 *     }
 *     if (page.nextId === null) break;
 *     const next = await getCollectionItems(chain, 0, { limit: 100, fromId: page.nextId, at });
 *     if (!next.ok || next.value.tag !== "Found") break;
 *     page = next.value;
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
        const snapshot = await pinBlock(chain, signal, options.at);
        const at = readAt(snapshot, signal);
        const query = chain.assetHub.query;
        const { limit, fromId } = pageBounds(options);

        // The record carries the index ceiling, so unlike the collection listing
        // this read pays nothing extra to learn where the space ends.
        const record = query.Scarcity.Collections.getValue(id, at);
        const defaults = query.Scarcity.CollectionMetadata.getEntries(id, at);

        // Every read is in flight before anything is awaited, and all of them are
        // awaited in one place. Awaiting the window first instead would leave a
        // rejection from `defaults` unhandled across the window's round trips,
        // which ends the process under Node's default rejection mode even though
        // this call goes on to return an error.
        const [filled, found, defaultRows] = await Promise.all([
            fillByIdWindow(
                fromId,
                limit,
                record.then((collection) => collection?.next_item_index ?? 0),
                (indices) =>
                    query.Scarcity.ItemDefs.getValues(
                        indices.map((index) => [id, index] as [number, number]),
                        at,
                    ),
            ),
            record,
            defaults,
        ]);
        if (found === undefined) {
            return ok({ tag: "NotFound", at: snapshot, id });
        }

        const defaultBag = collectionBag(defaultRows);
        const decodedDefaults = decodeBag(defaultBag);
        const indices = filled.kept.map(({ id: index }) => index);

        // The one branch: named keys for the page, or the whole collection's item
        // metadata when the open bag was asked for.
        const overrides = options.attributes
            ? await readAllKeys(query, id, at)
            : await readTypedKeys(query, id, indices, at);

        const items = filled.kept.map(({ id: index, value: def }): CollectionItem => {
            const raw = overrides.get(index) ?? {};
            const decoded = decodeBag(raw);
            return {
                index,
                supply: def.supply,
                liveSupply: def.live_supply,
                name: decoded.name ?? decodedDefaults.name ?? null,
                imageRef: imageRefFrom([defaultBag, raw]),
                rarity: decoded.rarity ?? decodedDefaults.rarity ?? null,
                attributes: options.attributes ? mergeMetadata(decodedDefaults, decoded) : null,
            };
        });

        return ok({
            tag: "Found",
            at: snapshot,
            idCeiling: filled.ceiling,
            nextId: filled.nextId,
            collection: {
                id,
                name: decodedDefaults.name ?? null,
                itemCount: found.item_count,
                items,
            },
        });
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

/**
 * The named metadata keys of many items, in one round trip.
 *
 * Three exact keys per item, flattened into a single `getValues`, then split back
 * per item by position. Raw bytes are kept rather than decoded strings, because
 * {@link imageRefFrom} reports `image` both ways and cannot recover bytes from a
 * decoded string.
 */
async function readTypedKeys(
    query: NftsChain["assetHub"]["query"],
    collection: number,
    indices: number[],
    at: ReadAt,
): Promise<Map<number, Record<string, RawBytes>>> {
    const byItem = new Map<number, Record<string, RawBytes>>();
    if (indices.length === 0) return byItem;

    const named = Object.entries(TYPED_KEYS);
    const keys = indices.flatMap((index) =>
        named.map(([, key]) => [collection, index, key] as [number, number, Uint8Array]),
    );
    const rows = await query.Scarcity.ItemMetadata.getValues(keys, at);

    indices.forEach((index, position) => {
        const bag: Record<string, RawBytes> = Object.create(null);
        named.forEach(([name], offset) => {
            const row = rows[position * named.length + offset];
            if (row !== undefined) bag[name] = row.value;
        });
        byItem.set(index, bag);
    });
    return byItem;
}

/**
 * Every metadata key of every item in the collection, grouped by item.
 *
 * The `attributes: true` path. One prefix scan, so one round trip — but it carries
 * the whole catalogue's metadata, which is the cost of a bag whose keys cannot be
 * named in advance.
 */
async function readAllKeys(
    query: NftsChain["assetHub"]["query"],
    collection: number,
    at: ReadAt,
): Promise<Map<number, Record<string, RawBytes>>> {
    return byItem(await query.Scarcity.ItemMetadata.getEntries(collection, at));
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const utf8 = (text: string) => new TextEncoder().encode(text);
    const BLOCK = { hash: `0x${"88".repeat(32)}`, number: 99 };
    const DIGEST = new Uint8Array(32).fill(0xab);

    type Bag = Array<[string, Uint8Array]>;

    function fakeChain(state: {
        record?: { owner: string; item_count: number; next_item_index?: number };
        defs?: Array<[number, { supply: number; live_supply: number }]>;
        itemMetadata?: Array<[number, Bag]>;
        collectionMetadata?: Bag;
    }) {
        const scans: string[] = [];
        let blocks = 0;
        const chain = {
            assetHub: {
                query: {
                    Scarcity: {
                        Collections: {
                            getValue: async () => {
                                scans.push("record");
                                if (state.record === undefined) return undefined;
                                return {
                                    ...state.record,
                                    // Indices are never reused, so the ceiling is
                                    // one past the highest ever defined.
                                    next_item_index:
                                        state.record.next_item_index ??
                                        Math.max(
                                            0,
                                            ...(state.defs ?? []).map(([index]) => index + 1),
                                        ),
                                };
                            },
                        },
                        ItemDefs: {
                            getValues: async (keys: Array<[number, number]>) => {
                                scans.push(`defs:${keys.map(([, i]) => i).join(",")}`);
                                return keys.map(([, index]) => {
                                    const hit = (state.defs ?? []).find(([i]) => i === index);
                                    return hit === undefined ? undefined : hit[1];
                                });
                            },
                            getEntries: async (collection: number) => {
                                scans.push(`defs:${collection}`);
                                return (state.defs ?? []).map(([index, value]) => ({
                                    keyArgs: [collection, index] as [number, number],
                                    value,
                                }));
                            },
                        },
                        ItemMetadata: {
                            getValues: async (keys: Array<[number, number, Uint8Array]>) => {
                                scans.push(`itemKeys:${keys.length}`);
                                const decode = new TextDecoder();
                                return keys.map(([, index, key]) => {
                                    const bag = (state.itemMetadata ?? []).find(
                                        ([i]) => i === index,
                                    )?.[1];
                                    const hit = bag?.find(([name]) => name === decode.decode(key));
                                    return hit === undefined ? undefined : { value: hit[1] };
                                });
                            },
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
            raw: {
                assetHub: {
                    getFinalizedBlock: async () => {
                        blocks += 1;
                        return BLOCK;
                    },
                },
            },
        } as unknown as NftsChain;
        return { chain, scans, blocks: () => blocks };
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

            const result = await getCollectionItems(chain, 0, { limit: 100, attributes: true });
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

            const result = await getCollectionItems(chain, 0, { limit: 100, attributes: true });
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            expect(result.value.collection.items[0]?.rarity).toBe("rare");
            expect(result.value.collection.items[0]?.attributes?.palette).toBe("moss");
        });

        test("a collection-level image is inherited", async () => {
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 1 },
                defs: [[0, { supply: 1, live_supply: 1 }]],
                collectionMetadata: [["image", DIGEST]],
            });
            const result = await getCollectionItems(chain, 0, { limit: 100 });
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
            const result = await getCollectionItems(chain, 0, { limit: 100, attributes: true });
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            const item = result.value.collection.items[0];
            expect(item?.imageRef?.text).toBe(cid);
            expect(item?.imageRef?.hex.startsWith("0x62616")).toBe(true);
            // The bag keeps the decoded reading, as it does for every key.
            expect(item?.attributes?.image).toBe(cid);
        });

        test("a missing collection is NotFound, not an error", async () => {
            const result = await getCollectionItems(fakeChain({}).chain, 9, { limit: 100 });
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
            const result = await getCollectionItems(chain, 1, { limit: 100 });
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
            const result = await getCollectionItems(chain, 0, { limit: 100 });
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            expect(result.value.collection.items.map((i) => i.index)).toEqual([2, 4, 7]);
        });

        test("item_count is reported as the chain has it, not recomputed", async () => {
            // The two are separate writes, so they can disagree mid-removal.
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 5 },
                defs: [[0, { supply: 1, live_supply: 1 }]],
            });
            const result = await getCollectionItems(chain, 0, { limit: 100 });
            if (!result.ok || result.value.tag !== "Found") throw new Error("expected Found");
            expect(result.value.collection.itemCount).toBe(5);
            expect(result.value.collection.items).toHaveLength(1);
        });

        test("reads by exact key rather than dumping any map", async () => {
            const { chain, scans } = fakeChain({
                record: { owner: "o", item_count: 2, next_item_index: 2 },
                defs: [
                    [0, { supply: 1, live_supply: 1 }],
                    [1, { supply: 1, live_supply: 1 }],
                ],
            });
            await getCollectionItems(chain, 3, { limit: 100 });
            // A window of item indices, then their named keys — no prefix scan of
            // the collection's item metadata unless `attributes` asks for one.
            expect(scans).toContain("itemKeys:6");
            expect(scans.some((s) => s.startsWith("itemMeta:"))).toBe(false);
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
            const result = await getCollectionItems(chain, 0, { limit: 100 });
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
                            ItemDefs: { getValues: async () => [] },
                            ItemMetadata: { getValues: async () => [] },
                            CollectionMetadata: { getEntries: async () => [] },
                        },
                    },
                },
                raw: { assetHub: { getFinalizedBlock: async () => BLOCK } },
            } as unknown as NftsChain;

            const result = await getCollectionItems(chain, 0, { limit: 100 });
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
                            ItemDefs: { getValues: async () => [] },
                            ItemMetadata: { getValues: async () => [] },
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

            const result = await getCollectionItems(chain, 0, { limit: 100 });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsChainEntryError);
        });

        test("a defaults read that fails first is still awaited, not left floating", async () => {
            // The ordering the fakes above cannot express. `CollectionMetadata`
            // rejects while the item-definition window is still in flight, so a
            // read that awaited the window before touching `defaults` would leave
            // that rejection unhandled across a macrotask boundary — which ends
            // the process under Node's default rejection mode, even though this
            // call goes on to return `err`. Vitest fails a test file on an
            // unhandled rejection, so this test is the assertion.
            const settleIn = <T>(ms: number, produce: () => T) =>
                new Promise<T>((resolve, reject) => {
                    setTimeout(() => {
                        try {
                            resolve(produce());
                        } catch (cause) {
                            reject(cause);
                        }
                    }, ms);
                });

            const chain = {
                assetHub: {
                    query: {
                        Scarcity: {
                            Collections: {
                                getValue: () =>
                                    settleIn(1, () => ({
                                        owner: "o",
                                        item_count: 1,
                                        next_item_index: 1,
                                    })),
                            },
                            ItemDefs: {
                                getValues: () =>
                                    settleIn(30, () => [{ supply: 1, live_supply: 1 }]),
                            },
                            ItemMetadata: { getValues: () => settleIn(1, () => []) },
                            CollectionMetadata: {
                                getEntries: () =>
                                    settleIn(5, () => {
                                        throw new Error("node dropped the metadata scan");
                                    }),
                            },
                        },
                    },
                },
                raw: { assetHub: { getFinalizedBlock: async () => BLOCK } },
            } as unknown as NftsChain;

            const result = await getCollectionItems(chain, 0, { limit: 100 });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(ProductNftsError);

            // Past the window read, so a floating rejection would have surfaced.
            await new Promise((resolve) => setTimeout(resolve, 50));
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

    describe("getCollectionItems, paging", () => {
        /** A collection of `count` items, with `deleted` indices pruned. */
        const catalogue = (count: number, deleted: number[] = []) =>
            fakeChain({
                record: { owner: "o", item_count: count - deleted.length, next_item_index: count },
                defs: Array.from({ length: count }, (_, index) => index)
                    .filter((index) => !deleted.includes(index))
                    .map(
                        (index) =>
                            [index, { supply: 3, live_supply: 2 }] as [
                                number,
                                { supply: number; live_supply: number },
                            ],
                    ),
                itemMetadata: Array.from({ length: count }, (_, index) => index)
                    .filter((index) => !deleted.includes(index))
                    .map(
                        (index) =>
                            [
                                index,
                                [
                                    ["name", utf8(`Item ${index}`)],
                                    ["rarity", utf8("common")],
                                    ["image", DIGEST],
                                ],
                            ] as [number, Bag],
                    ),
            });

        test("a page costs the same whatever the collection holds", async () => {
            const small = catalogue(20);
            const huge = catalogue(10_000);

            const a = await getCollectionItems(small.chain, 0, { limit: 10 });
            const b = await getCollectionItems(huge.chain, 0, { limit: 10 });
            expect(a.ok && b.ok).toBe(true);
            if (!a.ok || !b.ok || a.value.tag !== "Found" || b.value.tag !== "Found") return;

            expect(b.value.collection.items).toHaveLength(10);
            expect(huge.scans.length).toBe(small.scans.length);
            // Three exact keys per item in the window, in one read — not a scan
            // per item, and never the whole-collection prefix scan.
            expect(huge.scans).toContain("itemKeys:30");
            expect(huge.scans).not.toContain("itemMeta:0");
        });

        test("returns the typed fields, with the collection's defaults inherited", async () => {
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 2, next_item_index: 2 },
                defs: [
                    [0, { supply: 5, live_supply: 4 }],
                    [1, { supply: 1, live_supply: 1 }],
                ],
                collectionMetadata: [
                    ["name", utf8("Fallback name")],
                    ["rarity", utf8("common")],
                    ["image", DIGEST],
                ],
                // Item 0 overrides name only; item 1 sets nothing at all.
                itemMetadata: [[0, [["name", utf8("Hollow Beacon #0")]]]],
            });

            const result = await getCollectionItems(chain, 0, { limit: 10 });
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;

            expect(result.value.collection.items[0]).toEqual({
                index: 0,
                supply: 5,
                liveSupply: 4,
                name: "Hollow Beacon #0",
                rarity: "common",
                imageRef: { hex: `0x${"ab".repeat(32)}`, text: null },
                attributes: null,
            });
            // Inherits every default, exactly as a bigger page does.
            expect(result.value.collection.items[1]?.name).toBe("Fallback name");
            expect(result.value.collection.items[1]?.rarity).toBe("common");
            expect(result.value.collection.items[1]?.imageRef?.hex).toBe(`0x${"ab".repeat(32)}`);
        });

        test("attributes is null when not asked for, never an empty bag", async () => {
            const { chain, scans } = catalogue(5);
            const result = await getCollectionItems(chain, 0, { limit: 2 });
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;
            // `{}` would read as "this item has no metadata", which is a
            // different claim from "this read did not fetch it".
            expect(result.value.collection.items[0]?.attributes).toBeNull();
            // And nothing was scanned for it: the typed keys came back by exact
            // key, with no whole-collection metadata prefix scan.
            expect(scans.some((s) => s.startsWith("itemMeta:"))).toBe(false);
        });

        test("attributes: true fills the bag, at one prefix scan of the collection", async () => {
            const { chain, scans } = catalogue(5);
            const result = await getCollectionItems(chain, 0, {
                limit: 2,
                attributes: true,
            });
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;

            expect(result.value.collection.items[0]?.attributes).toEqual({
                name: "Item 0",
                rarity: "common",
                image: `0x${"ab".repeat(32)}`,
            });
            // One scan of the whole collection's item metadata — the cost of a
            // bag whose keys cannot be named in advance — and no exact-key read.
            expect(scans.filter((s) => s.startsWith("itemMeta:"))).toEqual(["itemMeta:0"]);
            expect(scans.some((s) => s.startsWith("itemKeys:"))).toBe(false);
        });

        test("walking nextId visits every item exactly once", async () => {
            const { chain } = catalogue(25);
            const seen: number[] = [];
            let fromId: number | null = 0;
            let pages = 0;

            while (fromId !== null) {
                const page = await getCollectionItems(chain, 0, { limit: 10, fromId });
                expect(page.ok).toBe(true);
                if (!page.ok || page.value.tag !== "Found") return;
                seen.push(...page.value.collection.items.map((i) => i.index));
                fromId = page.value.nextId;
                pages += 1;
            }

            expect(pages).toBe(3);
            expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i));
            expect(new Set(seen).size).toBe(seen.length);
        });

        test("a deleted item index is stepped over, so the page still fills", async () => {
            // `delete_item` never reuses an index, so the gap is permanent.
            const { chain } = catalogue(30, [2, 3]);
            const result = await getCollectionItems(chain, 0, { limit: 5 });
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;
            expect(result.value.collection.items.map((i) => i.index)).toEqual([0, 1, 4, 5, 6]);
            expect(result.value.nextId).toBe(7);
        });

        test("reports the index ceiling and the live count separately", async () => {
            // Two definitions deleted: 30 indices ever used, 28 alive.
            const { chain } = catalogue(30, [5, 6]);
            const result = await getCollectionItems(chain, 0, { limit: 1 });
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;
            expect(result.value.idCeiling).toBe(30);
            expect(result.value.collection.itemCount).toBe(28);
        });

        test("the last page ends the walk", async () => {
            const { chain } = catalogue(12);
            const result = await getCollectionItems(chain, 0, { limit: 10, fromId: 10 });
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;
            expect(result.value.collection.items.map((i) => i.index)).toEqual([10, 11]);
            expect(result.value.nextId).toBeNull();
        });

        test("a missing collection is NotFound, not an error", async () => {
            const result = await getCollectionItems(fakeChain({}).chain, 9, { limit: 10 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value).toEqual({
                tag: "NotFound",
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
                id: 9,
            });
        });

        test("an existing but empty collection is a Found page with no items", async () => {
            const { chain } = fakeChain({
                record: { owner: "o", item_count: 0, next_item_index: 0 },
            });
            const result = await getCollectionItems(chain, 1, { limit: 10 });
            expect(result.ok).toBe(true);
            if (!result.ok || result.value.tag !== "Found") return;
            expect(result.value.collection.items).toEqual([]);
            expect(result.value.nextId).toBeNull();
        });

        test("a whole walk can be pinned to one block", async () => {
            const { chain, blocks } = catalogue(25);
            const first = await getCollectionItems(chain, 0, { limit: 10 });
            expect(first.ok).toBe(true);
            if (!first.ok || first.value.tag !== "Found") return;

            let fromId = first.value.nextId;
            while (fromId !== null) {
                const page = await getCollectionItems(chain, 0, {
                    limit: 10,
                    fromId,
                    at: first.value.at,
                });
                expect(page.ok).toBe(true);
                if (!page.ok || page.value.tag !== "Found") return;
                expect(page.value.at).toEqual(first.value.at);
                fromId = page.value.nextId;
            }
            expect(blocks()).toBe(1);
        });

        test("small pages agree with one page holding the catalogue, on the typed fields", async () => {
            const { chain } = catalogue(9);
            const whole = await getCollectionItems(chain, 0, { limit: 100 });
            expect(whole.ok).toBe(true);
            if (!whole.ok || whole.value.tag !== "Found") return;

            const paged: Array<{ index: number; name: string | null; rarity: string | null }> = [];
            let fromId: number | null = 0;
            while (fromId !== null) {
                const page = await getCollectionItems(chain, 0, { limit: 4, fromId });
                expect(page.ok).toBe(true);
                if (!page.ok || page.value.tag !== "Found") return;
                paged.push(
                    ...page.value.collection.items.map((i) => ({
                        index: i.index,
                        name: i.name,
                        rarity: i.rarity,
                    })),
                );
                fromId = page.value.nextId;
            }

            expect(paged).toEqual(
                whole.value.collection.items.map((i) => ({
                    index: i.index,
                    name: i.name,
                    rarity: i.rarity,
                })),
            );
        });

        test("an aborted signal lands on the err channel", async () => {
            const controller = new AbortController();
            controller.abort();
            const result = await getCollectionItems(fakeChain({}).chain, 0, {
                limit: 10,
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
        });
    });
}
