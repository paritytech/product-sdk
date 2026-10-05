// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `getInstanceDisplays`, the display metadata of minted NFTs by instance id.
 *
 * The catalogue reads describe what a collection *defines*; this one describes
 * what somebody *holds*. An instance carries three metadata layers — its
 * collection's defaults, its item's overrides, and its own — and the pallet
 * resolves them most-specific-first (`instance_metadata_of`). The read asks the
 * runtime to do exactly that through `ScarcityApi.metadata_batch`, which also
 * answers which (collection, item) each instance was minted from, so a shelf
 * can group what it shows without a second lookup.
 *
 * Positional like `previewClaim`: `displays[i]` answers `instances[i]`. An
 * instance nobody minted, or one already burned, is a `NotFound` display rather
 * than an error — the runtime was asked and answered. The signal is the runtime
 * declining to resolve the query, **not** an empty metadata bag: a freshly
 * claim-minted instance carries no metadata at all on the live chain and is
 * still `Found`, with `null` typed fields and an empty bag.
 *
 * At most {@link MAX_INSTANCES_PER_READ} instances per call. The read is not
 * paged and does not need to be: every other read here walks a space the chain
 * sizes, while this one answers a list the caller already holds, so a cursor
 * would page someone over their own input. Above the cap it refuses and says
 * to split.
 *
 * On a deployment whose `metadata_batch` cap is at least that, which is the
 * live one, a full read is a single runtime call. `metadata_batch` refuses an
 * oversized batch outright rather than truncating, so a deployment configured
 * lower reports its cap in the refusal and the read re-chunks to it once
 * before giving up.
 *
 * Then one `ItemDefs` read, keyed by the `(collection, item)` pairs the batch
 * resolved and deduplicated, fills in `transferability`, `supply` and
 * `liveSupply`. Metadata cannot answer those, and whether an instance is
 * soulbound decides whether a UI may offer to send it, so it is read always
 * rather than behind a flag: the keys come from the answer already in hand, so
 * it costs one serial hop and nothing per instance beyond what was asked.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { pinAt, readAt, type NftsInstancesChain } from "./chain.js";
import { matchChainEntryError, NftsDecodeError, NftsIdError, ProductNftsError } from "./errors.js";
import { decodeBag, toTransferability } from "./items.js";
import { decodeMetadataKey, imageRefFrom, mergeMetadata } from "./metadata.js";
import type {
    InstanceDisplay,
    InstanceDisplayResult,
    InstanceDisplaysResult,
    PinnedReadOptions,
    RawBytes,
    RawItemDef,
    RawMetadataLayers,
    ReadAt,
} from "./types.js";

/**
 * The most instances one read answers for, and the size of a chunk.
 *
 * **This read is not paged, and this is why it does not need to be.** Every
 * other read here walks a space the chain decides the size of, so it hands
 * back a cursor. The instances are the caller's own list, so a cursor would
 * page someone over their own input; a cap and a refusal say the same thing
 * without the ceremony. Over the cap, split the list.
 *
 * 128 is this package's contract, not a reading of the chain. It coincides
 * with the batch cap live `next-asset-hub-paseo` configures for
 * `metadata_batch`, which is why a full read is one runtime call there — but
 * that cap is deployment configuration and this number must not be made to
 * track it. A deployment that allows fewer refuses with `TooLarge` carrying
 * its own cap, and the read re-chunks to that; a deployment that allows more
 * changes nothing here.
 *
 * Deliberately near {@link DEFAULT_PAGE_LIMIT} rather than
 * {@link MAX_PAGE_LIMIT}: a shelf is tens of NFTs, and a cap is a minor
 * change to raise and a breaking one to lower.
 */
export const MAX_INSTANCES_PER_READ = 128;

const U64_CEILING = 1n << 64n;

/**
 * The display metadata of many minted instances, in the order asked.
 *
 * At most {@link MAX_INSTANCES_PER_READ} instances, refused above that rather
 * than paged: the list is the caller's, so splitting it is the caller's to do.
 * One pinned block, one `metadata_batch` call, then one keyed `ItemDefs` read
 * for the definitions behind whatever resolved. An empty list is an empty
 * answer and no round trip past the pin. Duplicate ids are answered per
 * position, not deduplicated.
 *
 * @example
 * ```ts
 * const chain = await getChainAPI("paseo");
 * const result = await getInstanceDisplays(chain, [1n, 2n, 404n]);
 * if (result.ok) {
 *     for (const display of result.value.displays) {
 *         if (display.tag === "NotFound") continue; // burned, or never minted
 *         console.log(display.instance, display.name ?? "(unnamed)", display.rarity);
 *         // Offer a send only for an instance the runtime will let move.
 *         if (display.transferability === "Transferable") renderSendButton(display);
 *     }
 * }
 * ```
 */
export async function getInstanceDisplays(
    chain: NftsInstancesChain,
    instances: bigint[],
    options: PinnedReadOptions = {},
): Promise<Result<InstanceDisplaysResult, ProductNftsError>> {
    try {
        if (instances.length > MAX_INSTANCES_PER_READ) {
            return err(
                new ProductNftsError(
                    `getInstanceDisplays answers at most ${MAX_INSTANCES_PER_READ} instances per call, asked for ${instances.length}. Split the list; this read is not paged because the list is yours to page.`,
                ),
            );
        }
        for (const instance of instances) {
            if (instance < 0n || instance >= U64_CEILING) {
                return err(new NftsIdError(instance));
            }
        }
        const snapshot = await pinAt(chain.raw.assetHub, options.signal, options.at);
        if (instances.length === 0) return ok({ at: snapshot, displays: [] });
        const at = readAt(snapshot, options.signal);
        const layers = await readBatched(chain, instances, at);
        const defs = await readItemDefs(chain, layers, at);
        return ok({
            at: snapshot,
            displays: layers.map((answer, i) => toDisplay(instances[i] as bigint, answer, defs)),
        });
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

/**
 * The display metadata of one minted instance.
 *
 * `getInstanceDisplays` for a single id, for the flows that look one NFT up —
 * a detail view, a transfer confirmation. Reading a shelf one instance at a
 * time through this forfeits the batching; pass the list instead.
 */
export async function getInstanceDisplay(
    chain: NftsInstancesChain,
    instance: bigint,
    options: PinnedReadOptions = {},
): Promise<Result<InstanceDisplayResult, ProductNftsError>> {
    const result = await getInstanceDisplays(chain, [instance], options);
    if (!result.ok) return result;
    const display = result.value.displays[0];
    if (display === undefined) {
        return err(new NftsDecodeError("metadata_batch answered a different number of queries"));
    }
    return ok({ at: result.value.at, display });
}

/**
 * Every chunk through `metadata_batch`, reassembled positionally.
 *
 * Chunks go out in parallel: each is one runtime operation, and a shelf's
 * worth of instances is a few of them. A `TooLarge` refusal naming a cap below
 * the one used re-chunks only the instances that refusal covered, at the
 * runtime's number, once — the chunks that already answered are kept, and the
 * second attempt is at the cap the runtime itself reported, so a second refusal
 * is the runtime disagreeing with itself and surfaces as the error it is.
 */
async function readBatched(
    chain: NftsInstancesChain,
    instances: bigint[],
    at: ReadAt,
    limit: number = MAX_INSTANCES_PER_READ,
    retried = false,
): Promise<RawMetadataLayers[]> {
    const chunks: bigint[][] = [];
    for (let i = 0; i < instances.length; i += limit) {
        chunks.push(instances.slice(i, i + limit));
    }
    const results = await Promise.all(
        chunks.map((chunk) =>
            chain.assetHub.apis.ScarcityApi.metadata_batch(
                chunk.map((instance) => ({ type: "Instance" as const, value: instance })),
                at,
            ),
        ),
    );
    const answers: RawMetadataLayers[] = [];
    for (const [index, result] of results.entries()) {
        const chunk = chunks[index] ?? [];
        if (!result.success) {
            const refusal = result.value;
            const max = refusal.value?.max;
            if (!retried && typeof max === "number" && max > 0 && max < limit) {
                // Re-chunk only this refused chunk at the runtime's cap; the
                // chunks that answered keep their results.
                answers.push(...(await readBatched(chain, chunk, at, max, true)));
                continue;
            }
            // The variant and the numbers are runtime-reported, not
            // author-supplied, so naming them is safe and the difference
            // between "shrink the batch" and "this runtime is refusing".
            const reported = typeof max === "number" ? max : "unreported";
            const after = retried ? " after already re-chunking to the cap it reported" : "";
            throw new ProductNftsError(
                `metadata_batch refused a chunk of ${chunk.length} as too large (${refusal.type}, runtime max ${reported})${after}`,
            );
        }
        if (result.value.length !== chunk.length) {
            throw new NftsDecodeError("metadata_batch answered a different number of queries");
        }
        answers.push(...result.value);
    }
    return answers;
}

/** The key of one item definition, as a map key a `Map` can compare. */
const defKey = (collection: number, item: number): string => `${collection}/${item}`;

/**
 * The item definitions behind whatever the batch resolved, in one read.
 *
 * Keyed by the `(collection, item)` pairs `metadata_batch` just reported, so
 * nothing here scans and nothing is read that no instance points at. Pairs are
 * deduplicated first: a shelf of one collection is usually a handful of
 * definitions, and a key asked for twice is a storage operation spent twice.
 *
 * Serial after the metadata call by necessity — the keys are its answer. A
 * definition missing from the map is a real state, an instance outliving its
 * definition, and surfaces as `null` fields rather than an error.
 */
async function readItemDefs(
    chain: NftsInstancesChain,
    layers: RawMetadataLayers[],
    at: ReadAt,
): Promise<Map<string, RawItemDef>> {
    const keys: Array<[number, number]> = [];
    const seen = new Set<string>();
    for (const answer of layers) {
        const resolved = answer.resolved;
        if (resolved?.type !== "Instance") continue;
        const { collection, item } = resolved.value;
        const key = defKey(collection, item);
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push([collection, item]);
    }
    const defs = new Map<string, RawItemDef>();
    if (keys.length === 0) return defs;
    const values = await chain.assetHub.query.Scarcity.ItemDefs.getValues(keys, at);
    keys.forEach(([collection, item], index) => {
        const value = values[index];
        if (value !== undefined) defs.set(defKey(collection, item), value);
    });
    return defs;
}

/**
 * One layer's `[key, value]` pairs as a raw bag.
 *
 * `Object.create(null)` for the reason `byItem` in items.ts gives: keys are
 * author-supplied bytes, and a `__proto__` key on a `{}` bag would set the
 * prototype instead of landing as an own property.
 */
function bagOf(pairs: RawBytes[][]): Record<string, RawBytes> {
    const bag: Record<string, RawBytes> = Object.create(null);
    for (const pair of pairs) {
        const [key, value] = pair;
        if (key === undefined || value === undefined) {
            throw new NftsDecodeError("a metadata_batch layer row is not a key-value pair");
        }
        bag[decodeMetadataKey(key)] = value;
    }
    return bag;
}

function toDisplay(
    instance: bigint,
    answer: RawMetadataLayers,
    defs: Map<string, RawItemDef>,
): InstanceDisplay {
    const resolved = answer.resolved;
    if (resolved === undefined) return { tag: "NotFound", instance };
    if (resolved.type !== "Instance") {
        throw new NftsDecodeError(
            "metadata_batch resolved an instance query to a different kind of target",
        );
    }
    // The resolved payload names the instance it answers for, so an answer
    // that slipped position — right count, wrong order — cannot attach another
    // instance's name and transferability to the id asked at this slot.
    if (resolved.value.instance !== instance) {
        throw new NftsDecodeError(
            "metadata_batch resolved an answer under a different instance id than asked",
        );
    }
    const collection = bagOf(answer.collection);
    const item = bagOf(answer.item);
    const own = bagOf(answer.instance);
    const [decodedCollection, decodedItem, decodedOwn] = [
        decodeBag(collection),
        decodeBag(item),
        decodeBag(own),
    ] as const;
    // Most specific wins: the later layer overrides, so the order is
    // collection, item, instance — the same precedence `imageRefFrom` reads
    // backwards.
    const attributes = mergeMetadata(decodedCollection, decodedItem, decodedOwn);
    // Absent only when the definition is gone from under a live instance, so
    // the three fields it backs go null together rather than one at a time.
    const def = defs.get(defKey(resolved.value.collection, resolved.value.item));
    return {
        tag: "Found",
        instance,
        collection: resolved.value.collection,
        item: resolved.value.item,
        transferability: def ? toTransferability(def) : null,
        supply: def?.supply ?? null,
        liveSupply: def?.live_supply ?? null,
        // The item's own layers only. The collection's `name` names the
        // collection, not this instance, so it is reported beside rather than
        // inherited — see the note on `InstanceDisplay.name`.
        name: decodedOwn.name ?? decodedItem.name ?? null,
        collectionName: decodedCollection.name ?? null,
        imageRef: imageRefFrom([collection, item, own]),
        rarity: attributes.rarity ?? null,
        attributes,
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const utf8 = (text: string) => new TextEncoder().encode(text);
    const pair = (key: string, value: string | Uint8Array): [Uint8Array, Uint8Array] => [
        utf8(key),
        typeof value === "string" ? utf8(value) : value,
    ];
    const BLOCK = { hash: `0x${"44".repeat(32)}`, number: 321 };

    /** A `Found` answer whose instance resolves to (collection 7, item 3). */
    const found = (
        layers: Partial<Pick<RawMetadataLayers, "collection" | "item" | "instance">>,
        resolved: { instance: bigint; collection: number; item: number },
    ): RawMetadataLayers => ({
        resolved: { type: "Instance", value: resolved },
        collection: layers.collection ?? [],
        item: layers.item ?? [],
        instance: layers.instance ?? [],
    });
    const missing = (): RawMetadataLayers => ({ collection: [], item: [], instance: [] });

    const def = (transferability: string, supply = 10, liveSupply = 7): RawItemDef =>
        ({
            supply,
            live_supply: liveSupply,
            transferability: { type: transferability },
        }) as RawItemDef;

    /** Every definition the fakes use unless a test says otherwise. */
    const DEFS: Record<string, RawItemDef> = {
        "7/3": def("Transferable", 500, 499),
        "0/0": def("Transferable"),
        "0/1": def("Transferable"),
        "2/0": def("Soulbound", 1, 1),
    };

    function fakeChain(
        answer: (
            queries: Array<{ type: string; value: bigint }>,
        ) =>
            | { success: true; value: RawMetadataLayers[] }
            | { success: false; value: { type: "TooLarge"; value: { max: number } } },
        defs: Record<string, RawItemDef> = DEFS,
    ) {
        const batches: bigint[][] = [];
        const defKeys: Array<Array<[number, number]>> = [];
        let blocks = 0;
        const chain = {
            assetHub: {
                query: {
                    Scarcity: {
                        ItemDefs: {
                            getValues: async (keys: Array<[number, number]>) => {
                                defKeys.push(keys);
                                return keys.map(([c, i]) => defs[`${c}/${i}`]);
                            },
                        },
                    },
                },
                apis: {
                    ScarcityApi: {
                        metadata_batch: async (queries: Array<{ type: string; value: bigint }>) => {
                            batches.push(queries.map((q) => q.value));
                            return answer(queries);
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
                    getBestBlocks: async () => {
                        blocks += 1;
                        return [BLOCK];
                    },
                },
            },
        } as unknown as NftsInstancesChain;
        return { chain, batches, defKeys, blocks: () => blocks };
    }

    const answerByInstance =
        (state: Record<string, RawMetadataLayers>) =>
        (queries: Array<{ type: string; value: bigint }>) => ({
            success: true as const,
            value: queries.map((q) => state[q.value.toString()] ?? missing()),
        });

    describe("getInstanceDisplays", () => {
        test("resolves the three layers most specific first", async () => {
            const { chain, batches } = fakeChain(
                answerByInstance({
                    "9": found(
                        {
                            collection: [
                                pair("name", "Animals"),
                                pair("rarity", "common"),
                                pair("palette", "warm"),
                            ],
                            item: [pair("name", "Red Panda"), pair("rarity", "rare")],
                            instance: [pair("name", "Red Panda #9")],
                        },
                        { instance: 9n, collection: 7, item: 3 },
                    ),
                }),
            );
            const result = await getInstanceDisplays(chain, [9n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
            expect(result.value.displays).toEqual([
                {
                    tag: "Found",
                    instance: 9n,
                    collection: 7,
                    item: 3,
                    transferability: "Transferable",
                    supply: 500,
                    liveSupply: 499,
                    name: "Red Panda #9",
                    collectionName: "Animals",
                    rarity: "rare",
                    imageRef: null,
                    attributes: {
                        name: "Red Panda #9",
                        rarity: "rare",
                        palette: "warm",
                    },
                },
            ]);
            expect(batches).toEqual([[9n]]);
        });

        test("a collection name is not reported as the instance's name", async () => {
            // The live shape this exists for: the collection names itself and
            // titles its items by `archetype`, so merging the two layers would
            // report "Hearth" for an item the deployment calls "Greek Coffee".
            // Found by porting the read into an app whose own test caught it.
            const { chain } = fakeChain(
                answerByInstance({
                    "4": found(
                        {
                            collection: [pair("name", "Hearth"), pair("maxTiltDeg", "30")],
                            item: [pair("archetype", "greek-coffee")],
                        },
                        { instance: 4n, collection: 0, item: 0 },
                    ),
                }),
            );
            const result = await getInstanceDisplays(chain, [4n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const display = result.value.displays[0];
            expect(display?.tag).toBe("Found");
            if (display?.tag !== "Found") return;
            expect(display.name).toBeNull();
            expect(display.collectionName).toBe("Hearth");
            // The merged bag still carries both, and still resolves the keys
            // where inheriting the collection's value is the right answer.
            expect(display.attributes.name).toBe("Hearth");
            expect(display.attributes.maxTiltDeg).toBe("30");
        });

        test("the instance's own name wins over its item's", async () => {
            const { chain } = fakeChain(
                answerByInstance({
                    "4": found(
                        {
                            collection: [pair("name", "Animals")],
                            item: [pair("name", "Red Panda")],
                            instance: [pair("name", "Red Panda #4")],
                        },
                        { instance: 4n, collection: 0, item: 0 },
                    ),
                }),
            );
            const result = await getInstanceDisplays(chain, [4n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const display = result.value.displays[0];
            expect(display?.tag === "Found" && display.name).toBe("Red Panda #4");
            expect(display?.tag === "Found" && display.collectionName).toBe("Animals");
        });

        test("an unresolved query is NotFound, positionally", async () => {
            const { chain } = fakeChain(
                answerByInstance({
                    "1": found({}, { instance: 1n, collection: 0, item: 0 }),
                }),
            );
            const result = await getInstanceDisplays(chain, [404n, 1n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.displays.map((d) => d.tag)).toEqual(["NotFound", "Found"]);
            expect(result.value.displays[0]).toEqual({ tag: "NotFound", instance: 404n });
        });

        test("a resolved instance with empty layers is Found, not NotFound", async () => {
            // A claim-minted instance on the live chain: it exists and carries
            // no metadata at all. The empty bag must not read as a miss.
            const { chain } = fakeChain(
                answerByInstance({
                    "5": found({}, { instance: 5n, collection: 2, item: 0 }),
                }),
            );
            const result = await getInstanceDisplays(chain, [5n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.displays[0]).toEqual({
                tag: "Found",
                instance: 5n,
                collection: 2,
                item: 0,
                transferability: "Soulbound",
                supply: 1,
                liveSupply: 1,
                name: null,
                collectionName: null,
                rarity: null,
                imageRef: null,
                attributes: {},
            });
        });

        test("the item definition fills transferability and the supplies", async () => {
            const { chain, defKeys } = fakeChain(
                answerByInstance({
                    "5": found({}, { instance: 5n, collection: 2, item: 0 }),
                }),
            );
            const result = await getInstanceDisplays(chain, [5n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const display = result.value.displays[0];
            expect(display?.tag === "Found" && display.transferability).toBe("Soulbound");
            expect(defKeys).toEqual([[[2, 0]]]);
        });

        test("one definition read, keyed by what resolved and deduplicated", async () => {
            // Three instances of two definitions: two keys, not three.
            const { chain, defKeys } = fakeChain(
                answerByInstance({
                    "1": found({}, { instance: 1n, collection: 0, item: 0 }),
                    "2": found({}, { instance: 2n, collection: 0, item: 0 }),
                    "3": found({}, { instance: 3n, collection: 0, item: 1 }),
                }),
            );
            const result = await getInstanceDisplays(chain, [1n, 2n, 3n]);
            expect(result.ok).toBe(true);
            expect(defKeys).toEqual([
                [
                    [0, 0],
                    [0, 1],
                ],
            ]);
        });

        test("a definition gone from under a live instance is null, not an error", async () => {
            const { chain } = fakeChain(
                answerByInstance({
                    "8": found(
                        { instance: [pair("name", "Orphan")] },
                        {
                            instance: 8n,
                            collection: 9,
                            item: 9,
                        },
                    ),
                }),
                {}, // no definitions at all
            );
            const result = await getInstanceDisplays(chain, [8n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const display = result.value.displays[0];
            expect(display?.tag).toBe("Found");
            if (display?.tag !== "Found") return;
            // The metadata still reads; only the definition-backed fields go null.
            expect(display.name).toBe("Orphan");
            expect(display.transferability).toBeNull();
            expect(display.supply).toBeNull();
            expect(display.liveSupply).toBeNull();
        });

        test("an unknown transferability variant is an error, not a guess", async () => {
            const { chain } = fakeChain(
                answerByInstance({
                    "1": found({}, { instance: 1n, collection: 0, item: 0 }),
                }),
                { "0/0": def("Escrowed") },
            );
            const result = await getInstanceDisplays(chain, [1n]);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });

        test("all-NotFound costs no definition read", async () => {
            const { chain, defKeys } = fakeChain(answerByInstance({}));
            const result = await getInstanceDisplays(chain, [404n, 405n]);
            expect(result.ok).toBe(true);
            expect(defKeys).toEqual([]);
        });

        test("the image is read from the most specific layer that sets it", async () => {
            const digest = new Uint8Array(32).fill(0xab);
            const { chain } = fakeChain(
                answerByInstance({
                    "2": found(
                        {
                            collection: [pair("image", "bafkcollection")],
                            item: [pair("image", digest)],
                        },
                        { instance: 2n, collection: 0, item: 1 },
                    ),
                }),
            );
            const result = await getInstanceDisplays(chain, [2n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const display = result.value.displays[0];
            expect(display?.tag === "Found" && display.imageRef).toEqual({
                hex: `0x${"ab".repeat(32)}`,
                text: null,
            });
        });

        test("a bag with a __proto__ key stays a bag", async () => {
            const { chain } = fakeChain(
                answerByInstance({
                    "3": found(
                        { instance: [pair("__proto__", "polluted")] },
                        { instance: 3n, collection: 0, item: 0 },
                    ),
                }),
            );
            const result = await getInstanceDisplays(chain, [3n]);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const display = result.value.displays[0];
            expect(display?.tag === "Found" && display.attributes.__proto__).toBe("polluted");
        });

        test("a full list is one call, answered in order", async () => {
            const state: Record<string, RawMetadataLayers> = {};
            const ids = Array.from({ length: MAX_INSTANCES_PER_READ }, (_, i) => BigInt(i));
            for (const id of ids) {
                state[id.toString()] = found(
                    { instance: [pair("name", `#${id}`)] },
                    { instance: id, collection: 0, item: 0 },
                );
            }
            const { chain, batches } = fakeChain(answerByInstance(state));
            const result = await getInstanceDisplays(chain, ids);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            // The cap is the chunk size, so a maxed-out read never splits.
            expect(batches.map((b) => b.length)).toEqual([MAX_INSTANCES_PER_READ]);
            expect(result.value.displays.map((d) => (d.tag === "Found" ? d.name : null))).toEqual(
                ids.map((id) => `#${id}`),
            );
        });

        test("one instance over the cap is refused before the pin", async () => {
            const { chain, batches, blocks } = fakeChain(answerByInstance({}));
            const ids = Array.from({ length: MAX_INSTANCES_PER_READ + 1 }, (_, i) => BigInt(i));
            const result = await getInstanceDisplays(chain, ids);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            // Not an NftsIdError: every id here can address chain state, there
            // are just too many of them.
            expect(result.error).toBeInstanceOf(ProductNftsError);
            expect(result.error).not.toBeInstanceOf(NftsIdError);
            expect(result.error.message).toContain(String(MAX_INSTANCES_PER_READ));
            expect(blocks()).toBe(0);
            expect(batches).toEqual([]);
        });

        test("a TooLarge naming a smaller cap re-chunks to it", async () => {
            const state: Record<string, RawMetadataLayers> = {};
            const ids = Array.from({ length: 10 }, (_, i) => BigInt(i));
            for (const id of ids) {
                state[id.toString()] = found({}, { instance: id, collection: 0, item: 0 });
            }
            const answer = answerByInstance(state);
            const { chain, batches } = fakeChain((queries) =>
                queries.length > 4
                    ? { success: false, value: { type: "TooLarge", value: { max: 4 } } }
                    : answer(queries),
            );
            const result = await getInstanceDisplays(chain, ids);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.displays).toHaveLength(10);
            // One refused attempt at 10, then the re-run at the reported cap.
            expect(batches.map((b) => b.length)).toEqual([10, 4, 4, 2]);
        });

        test("a TooLarge at the runtime's own cap is an error naming the numbers", async () => {
            const { chain } = fakeChain(() => ({
                success: false,
                value: { type: "TooLarge", value: { max: 1024 } },
            }));
            const result = await getInstanceDisplays(chain, [1n]);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.message).toContain("too large");
            // The variant and the cap the runtime reported, so a caller
            // debugging a refusal is not pointed at batch sizing it already
            // satisfies.
            expect(result.error.message).toContain("TooLarge");
            expect(result.error.message).toContain("1024");
        });

        test("a second TooLarge refusal is an error, not another re-run", async () => {
            // The retry already runs at the cap the runtime itself reported, so
            // a runtime whose cap keeps shrinking is disagreeing with itself —
            // re-chunking again would silently re-ask a chunk per shrink.
            let cap = 4;
            const { chain, batches } = fakeChain(() => {
                const refusal = {
                    success: false as const,
                    value: { type: "TooLarge" as const, value: { max: cap } },
                };
                cap = 2;
                return refusal;
            });
            const ids = Array.from({ length: 10 }, (_, i) => BigInt(i));
            const result = await getInstanceDisplays(chain, ids);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.message).toContain("too large");
            // One attempt at 10, one re-run at the reported cap of 4 — and no
            // third wave at 2.
            expect(batches.map((b) => b.length)).toEqual([10, 4, 4, 2]);
        });

        test("an answer with the wrong number of entries is an error", async () => {
            const { chain } = fakeChain(() => ({ success: true, value: [missing()] }));
            const result = await getInstanceDisplays(chain, [1n, 2n]);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });

        test("an answer carrying a different instance id than asked is an error", async () => {
            // Right count, wrong identity — a shifted or reordered answer must
            // not attach another instance's name and transferability to the
            // asked id, where a Soulbound one could render as Transferable.
            const { chain } = fakeChain(() => ({
                success: true,
                value: [found({}, { instance: 2n, collection: 0, item: 0 })],
            }));
            const result = await getInstanceDisplays(chain, [1n]);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });

        test("a query resolved to a non-instance target is an error", async () => {
            const { chain } = fakeChain(() => ({
                success: true,
                value: [
                    {
                        resolved: { type: "Collection", value: 7 },
                        collection: [],
                        item: [],
                        instance: [],
                    } as RawMetadataLayers,
                ],
            }));
            const result = await getInstanceDisplays(chain, [1n]);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });

        test("no instances is no round trip past the pin", async () => {
            const { chain, batches, blocks } = fakeChain(answerByInstance({}));
            const result = await getInstanceDisplays(chain, []);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.displays).toEqual([]);
            expect(batches).toEqual([]);
            expect(blocks()).toBe(1);
        });

        test("an instance id outside u64 is refused before the pin", async () => {
            const { chain, blocks } = fakeChain(answerByInstance({}));
            for (const id of [-1n, 1n << 64n]) {
                const result = await getInstanceDisplays(chain, [id]);
                expect(result.ok).toBe(false);
                if (result.ok) return;
                expect(result.error).toBeInstanceOf(NftsIdError);
            }
            expect(blocks()).toBe(0);
        });

        test("joins a block another read pinned", async () => {
            const { chain, blocks } = fakeChain(answerByInstance({}));
            const given = { blockHash: `0x${"aa".repeat(32)}`, blockNumber: 5 };
            const result = await getInstanceDisplays(chain, [], { at: given });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.at).toEqual(given);
            expect(blocks()).toBe(0);
        });

        test("an aborted signal is an error before any round trip", async () => {
            const { chain, blocks, batches } = fakeChain(answerByInstance({}));
            const controller = new AbortController();
            controller.abort();
            const result = await getInstanceDisplays(chain, [1n], {
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
            expect(blocks()).toBe(0);
            expect(batches).toEqual([]);
        });
    });

    describe("getInstanceDisplay", () => {
        test("answers for the one instance", async () => {
            const { chain } = fakeChain(
                answerByInstance({
                    "9": found(
                        { item: [pair("name", "Red Panda")] },
                        { instance: 9n, collection: 7, item: 3 },
                    ),
                }),
            );
            const result = await getInstanceDisplay(chain, 9n);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.display.tag).toBe("Found");
            expect(result.value.display.tag === "Found" && result.value.display.name).toBe(
                "Red Panda",
            );
        });

        test("a miss is NotFound on the ok channel", async () => {
            const { chain } = fakeChain(answerByInstance({}));
            const result = await getInstanceDisplay(chain, 404n);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.display).toEqual({ tag: "NotFound", instance: 404n });
        });
    });
}
