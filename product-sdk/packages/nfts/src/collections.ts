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
 *   entry has a `selection`. What a picker wants. Four reads a page, and bytes
 *   proportional to the page.
 * - `getCollections` — the superset. Driven by the records, with `selection`
 *   `null` where no registration exists. What a browser or an audit wants. Four
 *   reads a page.
 *
 * Both are paged, and neither has an unpaged mode: `limit` defaults to
 * {@link DEFAULT_PAGE_LIMIT} and caps at {@link MAX_PAGE_LIMIT}, and `nextId`
 * carries the walk to the end. Ids are allocated sequentially and never reused,
 * so a page costs four storage reads whatever the chain holds.
 *
 * They page over the same id space and differ only in what makes an id
 * interesting. For `getClaimableCollections` the gaps are unregistered
 * collections rather than deleted ones, so its pages come back short on a chain
 * that registers little of what it carries — follow `nextId` rather than reading
 * a short page as the end. Prefer this read whenever only claimable collections
 * belong in the answer.
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
import { fillByIdWindow, pageBounds } from "./paging.js";
import { matchChainEntryError, NftsDecodeError, ProductNftsError } from "./errors.js";
import { decodeMetadataValue, NAME_KEY } from "./metadata.js";
import type {
    ClaimableCollection,
    Collection,
    FinalizedSnapshot,
    ItemSelection,
    RawMinter,
    ReadAt,
} from "./types.js";

/** What one `getClaimableCollections` call returns. */
export interface ClaimableCollectionsResult {
    at: FinalizedSnapshot;
    collections: ClaimableCollection[];
    /**
     * The exclusive upper bound of the collection id space at `at`, which is what
     * `fromId` and `nextId` are relative to.
     *
     * Not the size of the registry: it counts every collection ever created,
     * registered or not.
     */
    idCeiling: number;
    /**
     * The `fromId` a next page should use, or `null` when the walk reached the
     * end of the id space.
     *
     * Every read here is paged, so `null` means the end of the space and nothing
     * else — a non-null cursor is never "there happened to be more".
     */
    nextId: number | null;
}

export interface GetClaimableCollectionsOptions {
    /**
     * How many claimable collections this page returns, defaulting to
     * {@link DEFAULT_PAGE_LIMIT} and capped at {@link MAX_PAGE_LIMIT}.
     *
     * Pages the same way {@link GetCollectionsOptions.limit} does — by walking
     * the collection id space, since `NftClaims.CollectionMinters` is keyed by
     * collection id too — with one difference worth knowing. The gaps a page
     * steps over here are *unregistered* collections, not deleted ones, and how
     * many there are is a property of the deployment: one carries six
     * collections and registers one, another registers most of what it carries.
     * So a page fills while roughly one collection in sixteen is registered, and
     * comes back short below that.
     *
     * A short page is not the end of the registry. `nextId === null` is the only
     * end signal, so follow it rather than counting what came back — on a sparse
     * registry that is how the rest of it arrives.
     */
    limit?: number;
    /**
     * Where the walk starts, defaulting to 0.
     *
     * Take it from the previous page's `nextId`. Ids are only ever appended, so
     * resuming there cannot skip or repeat a collection.
     */
    fromId?: number;
    /**
     * Address a block a previous read already pinned, instead of pinning a new
     * one.
     *
     * Pass a `FinalizedSnapshot` straight from another result's `at`. Without it
     * every call pins its own finalized block, which is right for unrelated
     * questions and wrong for one question asked in pages: a walk over its own
     * snapshots is not a walk of any single chain state. It is also how two reads
     * are made to agree — the registry and the full list at one block.
     *
     * The node must still have the block pinned. Reuse a recent snapshot; an old
     * one leaves the follower's window and the read fails on the `err` channel.
     */
    at?: FinalizedSnapshot;
    /**
     * Forwarded into every underlying pull, so an aborted caller stops the whole
     * batch. No deadline is applied here — that belongs to the caller.
     */
    signal?: AbortSignal;
}

/** What one `getCollections` call returns. */
export interface CollectionsResult {
    at: FinalizedSnapshot;
    collections: Collection[];
    /**
     * The exclusive upper bound of the collection id space at `at`, from
     * `Scarcity.NextCollectionId`.
     *
     * Ids are allocated sequentially from 0 and never reused, so this is both the
     * count of collections ever created and the end of the id space a page walks.
     * It is **not** the number of live collections: deleting one leaves a
     * permanent hole below the ceiling.
     */
    idCeiling: number;
    /**
     * The `fromId` a next page should use, or `null` when this read reached the
     * end of the id space.
     *
     * Every read here is paged, so `null` means the end of the space and nothing
     * else — a non-null cursor is never "there happened to be more".
     */
    nextId: number | null;
}

export interface GetCollectionsOptions {
    /**
     * How many collections this page returns, defaulting to
     * {@link DEFAULT_PAGE_LIMIT} and capped at {@link MAX_PAGE_LIMIT}.
     *
     * **There is no "give me everything" here, on purpose.** Nothing on chain
     * bounds how many collections exist, so a read that returned all of them
     * would be priced at the size of the chain. A page costs a constant four
     * storage reads — the id ceiling plus three keyed reads over the window —
     * whatever the chain holds; walk `nextId` to the end for the rest.
     *
     * A page returns exactly `limit` collections, walking past ids whose
     * collections were deleted rather than coming up short. It returns fewer only
     * when the id space runs out, or — pathologically — when a mostly-deleted
     * range exhausts the scan budget. Either way `nextId === null` is the only
     * end signal, so follow it rather than counting.
     */
    limit?: number;
    /**
     * Where the window starts, defaulting to 0.
     *
     * Take it from the previous page's `nextId`, which is the id after the last
     * one that page returned. Because ids are only
     * ever appended and never reused, resuming there is stable: paging forward
     * cannot skip or repeat a collection while the chain is written to, which
     * offset-based paging over a mutable set cannot promise.
     */
    fromId?: number;
    /**
     * Address a block a previous read already pinned, instead of pinning a new
     * one.
     *
     * Pass a `FinalizedSnapshot` straight from another result's `at`. Without it
     * every call pins its own finalized block, which is right for unrelated
     * questions and wrong for one question asked in pages: a walk over its own
     * snapshots is not a walk of any single chain state. It is also how two reads
     * are made to agree — the registry and the full list at one block.
     *
     * The node must still have the block pinned. Reuse a recent snapshot; an old
     * one leaves the follower's window and the read fails on the `err` channel.
     */
    at?: FinalizedSnapshot;
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
 * Four storage reads a page, over two hops: the id ceiling and the registry
 * entries for the window together, then the records and names of the collections
 * that window found, each in one keyed read. Nothing is read one collection at a
 * time, and nothing pulls a byte for a collection the registry does not name — so
 * the cost is proportional to the page rather than to the chain.
 *
 * The walk is over the collection id space, not the registry — see
 * {@link GetClaimableCollectionsOptions.limit}, including why a sparse registry
 * gives short pages and why a short page is not the end.
 *
 * The registry is **not** small by construction, whatever its size on any
 * deployment read so far: nothing stops most of a chain's collections from
 * registering. So the cost here is stated in terms of how many do, not in terms
 * of a number that happens to hold today.
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
 *
 * // One page. Follow `nextId` for the rest, passing `at` back in to pin the walk.
 * const result = await getClaimableCollections(chain, { limit: 100 });
 * if (result.ok) {
 *     for (const collection of result.value.collections) {
 *         console.log(collection.id, collection.name ?? "(unnamed)", collection.itemCount);
 *     }
 *     console.log(result.value.nextId); // null when the id space is exhausted
 * }
 * ```
 */
export async function getClaimableCollections(
    chain: NftsChain,
    options: GetClaimableCollectionsOptions = {},
): Promise<Result<ClaimableCollectionsResult, ProductNftsError>> {
    try {
        const { signal } = options;
        const snapshot = await pinBlock(chain, signal, options.at);
        const at = readAt(snapshot, signal);
        const query = chain.assetHub.query;

        const { limit, fromId } = pageBounds(options);

        if (limit === 0) {
            const ceiling = await query.Scarcity.NextCollectionId.getValue(at);
            return ok({ at: snapshot, collections: [], idCeiling: ceiling, nextId: null });
        }

        // Which ids are registered, and where a next page resumes. Walking the id
        // space rather than dumping the registry is what keeps this bounded; the
        // gaps it steps over are unregistered collections.
        const filled = await fillByIdWindow(
            fromId,
            limit,
            query.Scarcity.NextCollectionId.getValue(at),
            (ids) =>
                query.NftClaims.CollectionMinters.getValues(
                    ids.map((id) => [id] as [number]),
                    at,
                ),
        );
        const registry = filled.kept.map(({ id, value }) => ({ id, minter: value }));
        const { ceiling: idCeiling, nextId } = filled;

        // Resolved before anything else is fetched: an unknown selection variant
        // should cost no further round trips.
        const registered = registry.map(({ id, minter }) => ({
            id,
            selection: toItemSelection(minter.selection),
        }));
        const ids = registered.map(({ id }) => id);

        // Both concurrently, for exactly the ids being returned — `chain.ts` has
        // what a multi-key read costs.
        const [records, names] = await Promise.all([
            query.Scarcity.Collections.getValues(
                ids.map((id) => [id] as [number]),
                at,
            ),
            readNames(query, ids, at),
        ]);

        const collections = registered.map(({ id, selection }, index): ClaimableCollection => {
            const record = records[index];
            return {
                id,
                name: names.get(id) ?? null,
                selection,
                itemCount: record?.item_count ?? null,
                owner: record?.owner ?? null,
            };
        });

        return ok({ at: snapshot, collections, idCeiling, nextId });
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

/**
 * The `name` of each of `ids`, by exact key.
 *
 * Exactly the rows wanted, whatever the chain holds — the alternative for a
 * subset of collections is a prefix scan each, or a whole-map dump that carries
 * every key of every collection to answer for a few. What that saves is bytes,
 * not operations: PAPI spends one per key either way (see `chain.ts`). Ids with
 * no `name` are absent from the map rather than present and null.
 */
async function readNames(
    query: NftsChain["assetHub"]["query"],
    ids: number[],
    at: ReadAt,
): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    if (ids.length === 0) return names;

    const rows = await query.Scarcity.CollectionMetadata.getValues(
        ids.map((id) => [id, NAME_KEY] as [number, Uint8Array]),
        at,
    );
    ids.forEach((id, index) => {
        const row = rows[index];
        if (row !== undefined) names.set(id, decodeMetadataValue(row.value));
    });
    return names;
}

/**
 * One page of `limit` collections, read by exact key from the id space.
 *
 * Two phases. First records, walking forward from `fromId` until `limit` live
 * ones are in hand — that is the read which says whether an id is live, and
 * skipping it for holes is why a page comes back full. Then the registry entries
 * and `name` rows, for exactly the ids the page will return.
 *
 * On a chain with no holes that is four storage reads over **two** sequential
 * hops — the ceiling and the first records read go out together, then the two
 * keyed reads — with the block pin on top unless the caller supplied one. Holes
 * cost extra record reads and nothing else: a deleted id is never given a name
 * or registry lookup.
 *
 * Nothing here scales with the chain. `SCAN_BUDGET_FACTOR` bounds the pathological
 * case where a range is mostly deleted.
 */
async function readPage(
    query: NftsChain["assetHub"]["query"],
    at: ReadAt,
    snapshot: FinalizedSnapshot,
    options: GetCollectionsOptions,
): Promise<CollectionsResult> {
    const { limit, fromId } = pageBounds(options);

    // Asking for nothing still reports the ceiling, so a caller can size a pager
    // without reading a page. `nextId` is `null` rather than `fromId` so a caller
    // looping on it terminates instead of spinning.
    if (limit === 0) {
        const idCeiling = await query.Scarcity.NextCollectionId.getValue(at);
        return { at: snapshot, collections: [], idCeiling, nextId: null };
    }

    // Records first: they are what says whether an id is live, and there is no
    // reason to fetch a name or a registry entry for an id this page will not
    // return.
    const {
        kept,
        ceiling: idCeiling,
        nextId,
    } = await fillByIdWindow(fromId, limit, query.Scarcity.NextCollectionId.getValue(at), (ids) =>
        query.Scarcity.Collections.getValues(
            ids.map((id) => [id] as [number]),
            at,
        ),
    );

    if (kept.length === 0) {
        return { at: snapshot, collections: [], idCeiling, nextId };
    }

    // Then the two keyed reads, for exactly the ids this page returns.
    const pageIds = kept.map(({ id }) => id);
    const [minters, names] = await Promise.all([
        query.NftClaims.CollectionMinters.getValues(
            pageIds.map((id) => [id] as [number]),
            at,
        ),
        readNames(query, pageIds, at),
    ]);

    const collections = kept.map(({ id, value: record }, index): Collection => {
        const minter = minters[index];
        return {
            id,
            name: names.get(id) ?? null,
            itemCount: record.item_count,
            owner: record.owner,
            selection: minter === undefined ? null : toItemSelection(minter.selection),
        };
    });

    // Already ascending — the id space was walked in order — so no sort here.
    return { at: snapshot, collections, idCeiling, nextId };
}

/**
 * Read every collection on chain, claimable or not, from one pinned finalized
 * block.
 *
 * The superset {@link getClaimableCollections} filters. One page is the id
 * ceiling plus three keyed reads for the page's ids — `Scarcity.Collections` for
 * the records, `NftClaims.CollectionMinters` to fill in `selection`, and
 * `Scarcity.CollectionMetadata` for the names — plus one more record read for
 * each stretch of deleted ids it steps over. `selection` is `null` for a
 * collection that accepts no claims.
 *
 * A minter entry whose `Scarcity.Collections` record is missing cannot appear
 * here, because this enumerates the records. {@link getClaimableCollections}
 * reports that case with null fields.
 *
 * **This read is always paged**, at `limit` collections a page, defaulting to
 * {@link DEFAULT_PAGE_LIMIT} and capped at {@link MAX_PAGE_LIMIT}. Dumping the
 * three maps whole would keep the operation count constant but not the payload:
 * a `CollectionMetadata` dump carries every metadata key of every collection
 * when only `name` is wanted, so most of what arrived would be discarded. At ten
 * thousand collections that is on the order of fifteen megabytes to produce ten
 * thousand summaries — too much for a browser tab, and enough that a public
 * endpoint may refuse the operation.
 *
 * So the read walks the id space in windows instead, at a flat four storage
 * reads per page — the id ceiling plus three keyed reads over the window —
 * whatever the chain holds. Four *reads*, which is not four round trips: PAPI
 * opens one operation per key, so a page's operations scale with `limit` and it
 * is the bytes that stay flat (see `chain.ts`). That works because the
 * id space is knowable and dense: `create_collection` takes no id, so the
 * runtime allocates sequentially from `Scarcity.NextCollectionId`, and
 * `delete_collection` documents that identifiers are never reused. So every
 * collection in `[fromId, fromId + limit)` can be fetched by exact key —
 * records, registry entries and `name` rows — with nothing proportional to the
 * chain anywhere in the read.
 *
 * **A page comes back full.** Ids of deleted collections are holes — no record,
 * and the runtime requires the metadata gone before deletion — so the read walks
 * past them until it has `limit` collections rather than handing back a short
 * page. That costs an extra record read where holes appear and nothing else: a
 * hole never gets a name or registry lookup. A page is short only at the end of
 * the id space, or when a mostly-deleted range hits
 * {@link SCAN_BUDGET_FACTOR}; `nextId === null` is the only end signal.
 *
 * PAPI has no storage cursor of its own (its options are `at` and `signal`, and
 * a prefix scan is all-or-nothing), but resuming by id is the better primitive
 * here regardless: because ids are only appended and never reused, **it is
 * stable**. Paging forward cannot skip or repeat a collection while the chain is
 * being written to, which offset-based paging over a mutable set cannot promise.
 *
 * @example
 * ```ts
 * // One page, then the rest — `at` pins the whole walk to one block.
 * const first = await getCollections(chain, { limit: 100 });
 * if (!first.ok) return;
 *
 * let page = first.value;
 * const at = page.at;
 * for (;;) {
 *     for (const c of page.collections) {
 *         console.log(c.id, c.name ?? "(unnamed)", c.selection ? "claimable" : "not claimable");
 *     }
 *     if (page.nextId === null) break;
 *     const next = await getCollections(chain, { limit: 100, fromId: page.nextId, at });
 *     if (!next.ok) break;
 *     page = next.value;
 * }
 * ```
 */
export async function getCollections(
    chain: NftsChain,
    options: GetCollectionsOptions = {},
): Promise<Result<CollectionsResult, ProductNftsError>> {
    try {
        const { signal } = options;
        const snapshot = await pinBlock(chain, signal, options.at);
        const at = readAt(snapshot, signal);
        const query = chain.assetHub.query;

        return ok(await readPage(query, at, snapshot, options));
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const utf8 = (text: string) => new TextEncoder().encode(text);
    const BLOCK = { hash: `0x${"77".repeat(32)}`, number: 42 };
    const { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } = await import("./paging.js");

    function fakeChain(overrides: {
        minters?: Array<{ keyArgs: [number]; value: RawMinter }>;
        records?: Record<number, { owner: string; item_count: number }>;
        metadata?: Record<number, Array<[string, string]>>;
        idCeiling?: number;
    }) {
        const calls: string[] = [];
        let blocks = 0;
        // Ids are sequential and never reused, so the ceiling is one past the
        // highest id ever created — which for a fake is the highest it holds.
        const ceiling =
            overrides.idCeiling ??
            Math.max(0, ...Object.keys(overrides.records ?? {}).map((id) => Number(id) + 1));
        const minterFor = (id: number) =>
            (overrides.minters ?? []).find((m) => m.keyArgs[0] === id)?.value;

        const chain = {
            assetHub: {
                query: {
                    NftClaims: {
                        CollectionMinters: {
                            getEntries: async () => {
                                calls.push("minters");
                                return overrides.minters ?? [];
                            },
                            getValues: async (keys: Array<[number]>) => {
                                calls.push(`minters:${keys.map(([id]) => id).join(",")}`);
                                return keys.map(([id]) => minterFor(id));
                            },
                        },
                    },
                    Scarcity: {
                        NextCollectionId: {
                            getValue: async () => {
                                calls.push("ceiling");
                                return ceiling;
                            },
                        },
                        Collections: {
                            getValue: async (id: number) => {
                                calls.push(`record:${id}`);
                                return overrides.records?.[id];
                            },
                            getValues: async (keys: Array<[number]>) => {
                                calls.push(`records:${keys.map(([id]) => id).join(",")}`);
                                return keys.map(([id]) => overrides.records?.[id]);
                            },
                            getEntries: async () => {
                                calls.push("records");
                                return Object.entries(overrides.records ?? {}).map(
                                    ([id, value]) => ({ keyArgs: [Number(id)], value }),
                                );
                            },
                        },
                        CollectionMetadata: {
                            // The contract only offers the one-collection prefix
                            // scan; the no-arg branch is a tripwire, so a
                            // regression to the old whole-map dump shows up in
                            // `calls` as "metadata" and fails the guards below.
                            getEntries: async (...args: unknown[]) => {
                                const rows = (id: number) =>
                                    (overrides.metadata?.[id] ?? []).map(([key, value]) => ({
                                        keyArgs: [id, utf8(key)] as [number, Uint8Array],
                                        value: { value: utf8(value) },
                                    }));

                                if (typeof args[0] === "number") {
                                    calls.push(`metadata:${args[0]}`);
                                    return rows(args[0]);
                                }
                                calls.push("metadata");
                                return Object.keys(overrides.metadata ?? {}).flatMap((id) =>
                                    rows(Number(id)),
                                );
                            },
                            getValues: async (keys: Array<[number, Uint8Array]>) => {
                                calls.push(`names:${keys.map(([id]) => id).join(",")}`);
                                const wanted = new TextDecoder().decode(NAME_KEY);
                                return keys.map(([id, key]) => {
                                    if (new TextDecoder().decode(key) !== wanted) return undefined;
                                    const hit = (overrides.metadata?.[id] ?? []).find(
                                        ([k]) => k === wanted,
                                    );
                                    return hit === undefined ? undefined : { value: utf8(hit[1]) };
                                });
                            },
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
        return { chain, calls, blocks: () => blocks };
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

        test("returns collections ascending by id", async () => {
            // Nothing sorts: the id walk visits the space in order, so ascending
            // output falls out of construction whatever order the fake holds.
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
            expect(calls).toContain("records:0");
            expect(calls).toContain("names:0");
        });

        test("records and names are each one keyed read, whatever the registry size", async () => {
            // No threshold, no dump: an exact-key name read asks for exactly the
            // rows wanted, so registry size changes the key count and nothing
            // else. (Key count, not request count — see `chain.ts`.)
            for (const size of [2, 30]) {
                const ids = Array.from({ length: size }, (_, id) => id);
                const { chain, calls } = fakeChain({
                    idCeiling: size,
                    minters: ids.map((id) => ({
                        keyArgs: [id] as [number],
                        value: { owner: "o", selection: { type: "Random" as const } },
                    })),
                    records: Object.fromEntries(
                        ids.map((id) => [id, { owner: "o", item_count: 0 }]),
                    ),
                    metadata: Object.fromEntries(
                        ids.map((id) => [
                            id,
                            [["name", `Collection ${id}`]] as Array<[string, string]>,
                        ]),
                    ),
                });

                const result = await getClaimableCollections(chain);
                expect(result.ok).toBe(true);
                if (!result.ok) return;
                expect(result.value.collections).toHaveLength(size);
                expect(result.value.collections[size - 1]?.name).toBe(`Collection ${size - 1}`);

                expect(calls.filter((c) => c.startsWith("records:"))).toHaveLength(1);
                expect(calls.filter((c) => c.startsWith("names:"))).toHaveLength(1);
                // The whole-chain metadata dump is gone from this read entirely.
                expect(calls).not.toContain("metadata");
                expect(calls.some((c) => c.startsWith("metadata:"))).toBe(false);
            }
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

    describe("getClaimableCollections, paged", () => {
        /** `every`th collection registered, out of `count`. */
        const registry = (count: number, every: number) => {
            const ids = Array.from({ length: count }, (_, id) => id);
            return fakeChain({
                idCeiling: count,
                records: Object.fromEntries(ids.map((id) => [id, { owner: "o", item_count: id }])),
                metadata: Object.fromEntries(
                    ids.map((id) => [id, [["name", `C${id}`]] as Array<[string, string]>]),
                ),
                minters: ids
                    .filter((id) => id % every === 0)
                    .map((id) => ({
                        keyArgs: [id] as [number],
                        value: { owner: "o", selection: { type: "Random" as const } },
                    })),
            });
        };

        test("a page of a dense registry fills and costs the same at any chain size", async () => {
            const small = registry(40, 1);
            const huge = registry(1_000_000, 1);

            const a = await getClaimableCollections(small.chain, { limit: 10 });
            const b = await getClaimableCollections(huge.chain, { limit: 10 });
            expect(a.ok && b.ok).toBe(true);
            if (!a.ok || !b.ok) return;

            expect(a.value.collections.map((c) => c.id)).toEqual(
                b.value.collections.map((c) => c.id),
            );
            expect(b.value.collections).toHaveLength(10);
            expect(b.value.nextId).toBe(10);
            expect(huge.calls.length).toBe(small.calls.length);
            // Never the registry dump — that is what paging replaces here.
            expect(huge.calls).not.toContain("minters");
        });

        test("a page steps over unregistered collections to fill itself", async () => {
            // Every third registered: filling 5 means walking 13 ids.
            const { chain } = registry(60, 3);
            const result = await getClaimableCollections(chain, { limit: 5 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections.map((c) => c.id)).toEqual([0, 3, 6, 9, 12]);
            expect(result.value.nextId).toBe(13);
            expect(result.value.collections[0]?.selection).toEqual({ tag: "Random" });
        });

        test("paging the registry visits every claimable collection exactly once", async () => {
            const { chain } = registry(50, 3);
            const seen: number[] = [];
            let fromId: number | null = 0;

            while (fromId !== null) {
                const page = await getClaimableCollections(chain, { fromId, limit: 4 });
                expect(page.ok).toBe(true);
                if (!page.ok) return;
                seen.push(...page.value.collections.map((c) => c.id));
                fromId = page.value.nextId;
            }

            const expected = Array.from({ length: 50 }, (_, id) => id).filter((id) => id % 3 === 0);
            expect(seen).toEqual(expected);
            expect(new Set(seen).size).toBe(seen.length);
        });

        test("small pages agree with one page that holds the whole registry", async () => {
            const { chain } = registry(30, 4);
            const all = await getClaimableCollections(chain);
            expect(all.ok).toBe(true);
            if (!all.ok) return;

            const paged: typeof all.value.collections = [];
            let fromId: number | null = 0;
            while (fromId !== null) {
                const page = await getClaimableCollections(chain, {
                    fromId,
                    limit: 3,
                    at: all.value.at,
                });
                expect(page.ok).toBe(true);
                if (!page.ok) return;
                paged.push(...page.value.collections);
                fromId = page.value.nextId;
            }
            expect(paged).toEqual(all.value.collections);
        });

        test("a registry too sparse to fill returns a short page and where to resume", async () => {
            // One in fifty registered, against a budget of sixteen ids per
            // collection asked for. This is the documented asymmetry with
            // `getCollections`: the page comes back short rather than reading on.
            const { chain } = registry(1000, 50);
            const result = await getClaimableCollections(chain, { limit: 10 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            expect(result.value.collections.length).toBeLessThan(10);
            expect(result.value.collections.map((c) => c.id)).toEqual([0, 50, 100, 150]);
            // Not the end — paging continues, it just takes more pages.
            expect(result.value.nextId).toBe(160);

            // And a sparse registry is small, so following `nextId` through the
            // short pages still reads all of it — which is why this trade is the
            // right way round.
            const all = await getClaimableCollections(chain);
            expect(all.ok).toBe(true);
            if (!all.ok) return;
            expect(all.value.collections).toHaveLength(20);
            expect(all.value.nextId).toBeNull();
        });

        test("a default page reports the id ceiling and no next page", async () => {
            const { chain } = registry(30, 4);
            const result = await getClaimableCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.idCeiling).toBe(30);
            expect(result.value.nextId).toBeNull();
        });

        test("a zero limit reports the ceiling without reading a page", async () => {
            const { chain, calls } = registry(30, 4);
            const result = await getClaimableCollections(chain, { limit: 0 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toEqual([]);
            expect(result.value.idCeiling).toBe(30);
            expect(result.value.nextId).toBeNull();
            expect(calls).toEqual(["ceiling"]);
        });

        test("an unknown selection variant in a page fails the read", async () => {
            const { chain } = fakeChain({
                idCeiling: 1,
                records: { 0: { owner: "o", item_count: 0 } },
                minters: [{ keyArgs: [0], value: { owner: "o", selection: { type: "Auction" } } }],
            });
            const result = await getClaimableCollections(chain, { limit: 1 });
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

        test("returns collections ascending by id", async () => {
            // Nothing sorts: the id walk visits the space in order, so ascending
            // output falls out of construction whatever order the fake holds.
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

        test("an omitted limit is a default page, not the whole chain", async () => {
            const size = 250;
            const ids = Array.from({ length: size }, (_, id) => id);
            const { chain, calls } = fakeChain({
                idCeiling: size,
                records: Object.fromEntries(ids.map((id) => [id, { owner: "o", item_count: 0 }])),
            });

            const result = await getCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            // The old behaviour here was "everything", which is the read that
            // works until a deployment grows and then breaks a browser tab.
            expect(result.value.collections).toHaveLength(DEFAULT_PAGE_LIMIT);
            expect(result.value.nextId).toBe(DEFAULT_PAGE_LIMIT);
            expect(result.value.idCeiling).toBe(size);
            // And nothing enumerated the chain to produce it.
            expect(calls).not.toContain("records");
            expect(calls).not.toContain("minters");
            expect(calls).not.toContain("metadata");
        });

        test("a limit past the maximum clamps rather than failing", async () => {
            const size = 3000;
            const ids = Array.from({ length: size }, (_, id) => id);
            const { chain } = fakeChain({
                idCeiling: size,
                records: Object.fromEntries(ids.map((id) => [id, { owner: "o", item_count: 0 }])),
            });

            const result = await getCollections(chain, { limit: 10_000 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toHaveLength(MAX_PAGE_LIMIT);
            // The cursor still says where the page stopped, so a walk stays correct.
            expect(result.value.nextId).toBe(MAX_PAGE_LIMIT);
        });

        test("each name is attributed to its own collection", async () => {
            // The exact-key name rows come back positionally, so a mismapping
            // here would hand one collection its neighbour's name — or a name
            // to a collection that sets none.
            const { chain } = fakeChain({
                records: {
                    0: { owner: "o", item_count: 0 },
                    1: { owner: "o", item_count: 0 },
                    2: { owner: "o", item_count: 0 },
                },
                metadata: {
                    0: [
                        ["palette", "moss"],
                        ["name", "zero"],
                    ],
                    // No `name` at all: must not inherit a neighbour's.
                    1: [["rarity", "common"]],
                    2: [
                        ["name", "two"],
                        ["style", "comets"],
                    ],
                },
            });

            const result = await getCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections.map((c) => c.name)).toEqual(["zero", null, "two"]);
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

        test("two reads can be made to agree by sharing a snapshot", async () => {
            // The other thing `at` buys: the registry and the full list at one
            // block, rather than at whatever block each happened to reach.
            const { chain, blocks } = sixCarriedOneRegistered();

            const all = await getCollections(chain);
            expect(all.ok).toBe(true);
            if (!all.ok) return;

            const claimable = await getClaimableCollections(chain, { at: all.value.at });
            expect(claimable.ok).toBe(true);
            if (!claimable.ok) return;

            expect(claimable.value.at).toEqual(all.value.at);
            expect(blocks()).toBe(1);
        });

        test("reports the id ceiling, and no next page when one page holds the chain", async () => {
            const result = await getCollections(sixCarriedOneRegistered().chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.idCeiling).toBe(2);
            expect(result.value.nextId).toBeNull();
        });
    });

    describe("getCollections, paged by id window", () => {
        // A chain big enough that dumping it is the thing to avoid.
        const manyCollections = (count: number, deleted: number[] = []) => {
            const live = Array.from({ length: count }, (_, id) => id).filter(
                (id) => !deleted.includes(id),
            );
            return fakeChain({
                idCeiling: count,
                records: Object.fromEntries(
                    live.map((id) => [id, { owner: `owner${id}`, item_count: id }]),
                ),
                metadata: Object.fromEntries(
                    live.map((id) => [
                        id,
                        [["name", `Collection ${id}`]] as Array<[string, string]>,
                    ]),
                ),
                minters: live
                    .filter((id) => id % 5 === 0)
                    .map((id) => ({
                        keyArgs: [id] as [number],
                        value: { owner: "o", selection: { type: "Random" as const } },
                    })),
            });
        };

        test("a page reads only its window, by exact key, and never dumps", async () => {
            const { chain, calls } = manyCollections(10_000);

            const result = await getCollections(chain, { fromId: 40, limit: 5 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            expect(result.value.collections.map((c) => c.id)).toEqual([40, 41, 42, 43, 44]);
            expect(result.value.collections[0]).toEqual({
                id: 40,
                name: "Collection 40",
                itemCount: 40,
                owner: "owner40",
                selection: { tag: "Random" },
            });
            // The whole point: nothing here enumerated the chain.
            expect(calls).not.toContain("records");
            expect(calls).not.toContain("minters");
            expect(calls).not.toContain("metadata");
            expect(calls).toEqual([
                "ceiling",
                "records:40,41,42,43,44",
                "minters:40,41,42,43,44",
                "names:40,41,42,43,44",
            ]);
        });

        test("cost per page is flat as the chain grows", async () => {
            const small = manyCollections(20);
            const huge = manyCollections(1_000_000);
            await getCollections(small.chain, { fromId: 0, limit: 10 });
            await getCollections(huge.chain, { fromId: 0, limit: 10 });
            expect(huge.calls.length).toBe(small.calls.length);
        });

        test("nextId walks the id space and ends exactly once", async () => {
            const { chain } = manyCollections(25);
            const seen: number[] = [];
            let fromId: number | null = 0;
            let pages = 0;

            while (fromId !== null) {
                const result = await getCollections(chain, { fromId, limit: 10 });
                expect(result.ok).toBe(true);
                if (!result.ok) return;
                seen.push(...result.value.collections.map((c) => c.id));
                fromId = result.value.nextId;
                pages += 1;
            }

            expect(pages).toBe(3);
            expect(seen).toEqual(Array.from({ length: 25 }, (_, id) => id));
            // No duplicates, which is the property an id window buys over an offset.
            expect(new Set(seen).size).toBe(seen.length);
        });

        test("asking for 10 returns 10 even where ids were deleted", async () => {
            // Ids are never reused, so the gap is permanent rather than
            // backfilled. The page scans past it instead of coming up short.
            const { chain, calls } = manyCollections(30, [3, 4]);

            const result = await getCollections(chain, { fromId: 0, limit: 10 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toHaveLength(10);
            expect(result.value.collections.map((c) => c.id)).toEqual([
                0, 1, 2, 5, 6, 7, 8, 9, 10, 11,
            ]);
            // Resumes after the last id it returned, not after the last it read.
            expect(result.value.nextId).toBe(12);
            // Holes cost record reads only: no name or registry lookup was made
            // for id 3 or 4.
            expect(calls.filter((c) => c.startsWith("names:"))).toEqual([
                "names:0,1,2,5,6,7,8,9,10,11",
            ]);
            expect(calls.filter((c) => c.startsWith("minters:"))).toEqual([
                "minters:0,1,2,5,6,7,8,9,10,11",
            ]);
        });

        test("paging across holes visits every collection exactly once", async () => {
            const deleted = [1, 2, 9, 10, 11, 23];
            const { chain } = manyCollections(30, deleted);
            const seen: number[] = [];
            let fromId: number | null = 0;

            while (fromId !== null) {
                const result = await getCollections(chain, { fromId, limit: 7 });
                expect(result.ok).toBe(true);
                if (!result.ok) return;
                seen.push(...result.value.collections.map((c) => c.id));
                fromId = result.value.nextId;
            }

            const expected = Array.from({ length: 30 }, (_, id) => id).filter(
                (id) => !deleted.includes(id),
            );
            expect(seen).toEqual(expected);
            expect(new Set(seen).size).toBe(seen.length);
        });

        test("every page is full until the id space runs out", async () => {
            const { chain } = manyCollections(20, [4, 5]);
            const sizes: number[] = [];
            let fromId: number | null = 0;

            while (fromId !== null) {
                const result = await getCollections(chain, { fromId, limit: 5 });
                expect(result.ok).toBe(true);
                if (!result.ok) return;
                sizes.push(result.value.collections.length);
                fromId = result.value.nextId;
            }

            // 18 live collections at 5 a page: only the last is short.
            expect(sizes.slice(0, -1).every((size) => size === 5)).toBe(true);
            expect(sizes.reduce((a, b) => a + b, 0)).toBe(18);
        });

        test("a mostly-deleted range gives up at the scan budget and says where to resume", async () => {
            // Pathological by construction: only the last id of 200 is live, and
            // a page of 5 may scan 80. It must not read on to find one.
            const deleted = Array.from({ length: 199 }, (_, id) => id);
            const { chain } = manyCollections(200, deleted);

            const result = await getCollections(chain, { fromId: 0, limit: 5 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toEqual([]);
            // Not `null`: the id space is not exhausted, so paging continues.
            expect(result.value.nextId).toBe(80);

            // Following `nextId` still gets there, in bounded steps — which is
            // the trade: a pathological range costs more pages, not more reads
            // per page.
            const found: number[] = [];
            let fromId: number | null = result.value.nextId;
            let pages = 1;
            while (fromId !== null) {
                const next = await getCollections(chain, { fromId, limit: 5 });
                expect(next.ok).toBe(true);
                if (!next.ok) return;
                found.push(...next.value.collections.map((c) => c.id));
                fromId = next.value.nextId;
                pages += 1;
            }
            expect(found).toEqual([199]);
            expect(pages).toBe(3);
        });

        test("starting past the end of the id space returns nothing", async () => {
            const { chain, calls } = manyCollections(10);
            const result = await getCollections(chain, { fromId: 50, limit: 10 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toEqual([]);
            expect(result.value.nextId).toBeNull();
            // The records read goes out alongside the ceiling rather than after
            // it, so this case spends one read it turns out not to need. That is
            // the trade for saving a sequential hop on every page that is in
            // range — and a caller following `nextId` never asks for this page.
            expect(calls.filter((c) => c.startsWith("names:"))).toEqual([]);
            expect(calls.filter((c) => c.startsWith("minters:"))).toEqual([]);
        });

        test("a window overrunning the ceiling keeps only the ids that exist", async () => {
            const { chain, calls } = manyCollections(12);
            const result = await getCollections(chain, { fromId: 8, limit: 10 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections.map((c) => c.id)).toEqual([8, 9, 10, 11]);
            expect(result.value.nextId).toBeNull();
            // Asked for ten ids without waiting to learn the ceiling; the four
            // that exist came back, and only those got a name lookup.
            expect(calls).toContain("records:8,9,10,11,12,13,14,15,16,17");
            expect(calls).toContain("names:8,9,10,11");
        });

        test("a whole walk can be pinned to one block", async () => {
            // The reason `at` exists. Without it each page pins its own
            // finalized block, so a walk is not a walk of any single state.
            const { chain, blocks } = fakeChain({
                idCeiling: 25,
                records: Object.fromEntries(
                    Array.from({ length: 25 }, (_, id) => [id, { owner: "o", item_count: 0 }]),
                ),
            });

            const first = await getCollections(chain, { limit: 10 });
            expect(first.ok).toBe(true);
            if (!first.ok) return;

            const seen = [...first.value.collections.map((c) => c.id)];
            let fromId = first.value.nextId;
            while (fromId !== null) {
                const page = await getCollections(chain, {
                    fromId,
                    limit: 10,
                    at: first.value.at,
                });
                expect(page.ok).toBe(true);
                if (!page.ok) return;
                // Every page reports the block the walk started at.
                expect(page.value.at).toEqual(first.value.at);
                seen.push(...page.value.collections.map((c) => c.id));
                fromId = page.value.nextId;
            }

            expect(seen).toEqual(Array.from({ length: 25 }, (_, id) => id));
            // One block pinned for the whole walk, not one per page.
            expect(blocks()).toBe(1);
        });

        test("the ceiling and the first records read go out together", async () => {
            // Two sequential hops, not three: nothing waits on the ceiling.
            const { chain, calls } = manyCollections(1000);
            await getCollections(chain, { fromId: 0, limit: 5 });
            expect(calls.slice(0, 2).sort()).toEqual(["ceiling", "records:0,1,2,3,4"]);
        });

        test("fromId defaults to the start of the id space", async () => {
            const { chain } = manyCollections(30);
            const result = await getCollections(chain, { limit: 3 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections.map((c) => c.id)).toEqual([0, 1, 2]);
        });

        test("a collection with no name in its window reports null, not a neighbour's", async () => {
            const { chain } = fakeChain({
                idCeiling: 3,
                records: Object.fromEntries(
                    [0, 1, 2].map((id) => [id, { owner: "o", item_count: 0 }]),
                ),
                metadata: { 0: [["name", "zero"]], 2: [["name", "two"]] },
            });
            const result = await getCollections(chain, { limit: 3 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections.map((c) => c.name)).toEqual(["zero", null, "two"]);
        });

        test("an unknown selection variant in a window fails the read", async () => {
            const { chain } = fakeChain({
                idCeiling: 1,
                records: { 0: { owner: "o", item_count: 0 } },
                minters: [{ keyArgs: [0], value: { owner: "o", selection: { type: "Auction" } } }],
            });
            const result = await getCollections(chain, { limit: 1 });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });

        test("a zero limit reads no keys", async () => {
            const { chain, calls } = manyCollections(10);
            const result = await getCollections(chain, { limit: 0 });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections).toEqual([]);
            expect(calls).toEqual(["ceiling"]);
        });

        test("a failing read lands on the err channel", async () => {
            // The throw sits on an entry the read actually calls — the ceiling
            // is the first storage touch of every page.
            const chain = {
                assetHub: {
                    query: {
                        Scarcity: {
                            NextCollectionId: {
                                getValue: async () => {
                                    throw new Error("node unreachable");
                                },
                            },
                            Collections: { getValues: async () => [] },
                            CollectionMetadata: { getValues: async () => [] },
                        },
                        NftClaims: { CollectionMinters: { getValues: async () => [] } },
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
