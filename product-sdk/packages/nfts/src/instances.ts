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
 * The batch is chunked below the runtime's query cap, 128 on live
 * `next-asset-hub-paseo`, because `metadata_batch` refuses an oversized batch
 * outright rather than truncating. A deployment configured lower reports its
 * cap in the refusal, and the read re-chunks to it once before giving up, so a
 * shelf of hundreds of purses costs a handful of runtime calls and no caller
 * ever learns the constant.
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
import { decodeBag } from "./items.js";
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
    Transferability,
} from "./types.js";

/**
 * Queries per `metadata_batch` call, matching the cap configured on live
 * `next-asset-hub-paseo`.
 *
 * The runtime refuses an oversized batch outright (`TooLarge`, carrying the
 * cap it would have accepted) rather than truncating, so the read chunks below
 * this and re-chunks once to a smaller reported cap. Exported for the same
 * reason {@link MAX_PAGE_LIMIT} is: so a caller sizing its own batches can
 * name the constant instead of rediscovering it.
 */
export const METADATA_BATCH_LIMIT = 128;

const U64_CEILING = 1n << 64n;

/**
 * The display metadata of many minted instances, in the order asked.
 *
 * One pinned block, one runtime call per {@link METADATA_BATCH_LIMIT}
 * instances with the chunks in parallel, then one keyed `ItemDefs` read for
 * the definitions behind them. An empty list is an empty answer and no round
 * trip past the pin. Duplicate ids are answered per position, not
 * deduplicated.
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
        for (const instance of instances) {
            if (instance < 0n || instance >= U64_CEILING) {
                return err(new NftsIdError(instance, "u64"));
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
 * the one used re-runs the whole batch at the runtime's number, once — the
 * second attempt is at the cap the runtime itself reported, so a second
 * refusal is the runtime disagreeing with itself and surfaces as the error it
 * is.
 */
async function readBatched(
    chain: NftsInstancesChain,
    instances: bigint[],
    at: ReadAt,
    limit: number = METADATA_BATCH_LIMIT,
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
        if (!result.success) {
            const max = result.value.value?.max;
            if (typeof max === "number" && max > 0 && max < limit) {
                return readBatched(chain, instances, at, max);
            }
            throw new ProductNftsError("metadata_batch refused a chunk as too large");
        }
        if (result.value.length !== chunks[index]?.length) {
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
    const collection = bagOf(answer.collection);
    const item = bagOf(answer.item);
    const own = bagOf(answer.instance);
    // Most specific wins: the later layer overrides, so the order is
    // collection, item, instance — the same precedence `imageRefFrom` reads
    // backwards.
    const attributes = mergeMetadata(decodeBag(collection), decodeBag(item), decodeBag(own));
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
        name: attributes.name ?? null,
        imageRef: imageRefFrom([collection, item, own]),
        rarity: attributes.rarity ?? null,
        attributes,
    };
}

/**
 * The `transferability` variant, refusing one this package does not know.
 *
 * A variant added to the runtime later would otherwise reach a caller as a
 * string the `Transferability` union says cannot occur, and the field that
 * decides whether to offer a send is the wrong one to guess at.
 */
function toTransferability(def: RawItemDef): Transferability {
    const type = def.transferability?.type;
    if (type !== "Transferable" && type !== "Soulbound") {
        throw new NftsDecodeError("an item definition carries an unknown transferability");
    }
    return type;
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

        test("chunks below the batch limit and reassembles in order", async () => {
            const state: Record<string, RawMetadataLayers> = {};
            const ids = Array.from({ length: 300 }, (_, i) => BigInt(i));
            for (const id of ids) {
                state[id.toString()] = found(
                    { instance: [pair("name", `#${id}`)] },
                    {
                        instance: id,
                        collection: 0,
                        item: 0,
                    },
                );
            }
            const { chain, batches } = fakeChain(answerByInstance(state));
            const result = await getInstanceDisplays(chain, ids);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(batches.map((b) => b.length)).toEqual([128, 128, 44]);
            expect(result.value.displays.map((d) => (d.tag === "Found" ? d.name : null))).toEqual(
                ids.map((id) => `#${id}`),
            );
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

        test("a TooLarge at the runtime's own cap is an error", async () => {
            const { chain } = fakeChain(() => ({
                success: false,
                value: { type: "TooLarge", value: { max: 1024 } },
            }));
            const result = await getInstanceDisplays(chain, [1n]);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.message).toContain("too large");
        });

        test("an answer with the wrong number of entries is an error", async () => {
            const { chain } = fakeChain(() => ({ success: true, value: [missing()] }));
            const result = await getInstanceDisplays(chain, [1n, 2n]);
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
