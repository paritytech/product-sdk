// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `previewClaim`, what one credit would mint in each of a list of collections.
 *
 * The answer comes from `NftClaimsApi.preview_mints`, which runs the real claim
 * selector without spending anything. For a `Random` collection the selection is
 * deterministic in the credit and the collection, so the preview is the item the
 * claim will produce, and switching collection is the only way to change it.
 * That is what makes a collection picker honest: it shows what you would get.
 *
 * The item that would mint is then resolved through the same exact-key metadata
 * path a catalogue page uses, so `name`, `rarity` and `imageRef` here agree
 * with `getCollectionItems` for the same item.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { pinBlock, readAt, type NftsChain } from "./chain.js";
import { matchChainEntryError, NftsDecodeError, NftsIdError, ProductNftsError } from "./errors.js";
import { toItemSelection } from "./collections.js";
import { collectionBag, decodeBag, readTypedKeys } from "./items.js";
import { imageRefFrom } from "./metadata.js";
import { isValidId } from "./paging.js";
import type { FinalizedSnapshot, MintPreview, MintPreviewResult, RawMintOutcome } from "./types.js";

export interface PreviewClaimOptions {
    /** The credit hash, `0x` prefixed, as `getClaims` reports it. */
    credit: string;
    /** The collections to preview into, from `getClaimableCollections`. */
    collections: number[];
    /** Join a block another read already pinned. */
    at?: FinalizedSnapshot;
    /** Forwarded into every underlying pull, so an aborted caller stops the batch. */
    signal?: AbortSignal;
}

function failureReason(reason: { type: string; value?: unknown }): string {
    if (
        reason.type === "UnknownItem" &&
        typeof reason.value === "object" &&
        reason.value !== null
    ) {
        const item = (reason.value as { item?: unknown }).item;
        return typeof item === "number" ? `UnknownItem ${item}` : reason.type;
    }
    return reason.type;
}

/**
 * Preview one credit against each of `collections`, in one runtime call.
 *
 * Returns a `Result`. A collection the credit cannot mint into is a `Fails`
 * outcome with the reason the runtime gave, not an error, because the chain was
 * asked and answered. An empty `collections` is an empty list and no round trip.
 *
 * @example
 * ```ts
 * const registry = await getClaimableCollections(chain);
 * if (!registry.ok) return;
 * const preview = await previewClaim(chain, {
 *     credit,
 *     collections: registry.value.collections.map((c) => c.id),
 *     at: registry.value.at,
 * });
 * if (preview.ok) {
 *     for (const p of preview.value.previews) {
 *         if (p.outcome.tag === "Mints") console.log(p.collection, p.outcome.name);
 *     }
 * }
 * ```
 */
export async function previewClaim(
    chain: NftsChain,
    options: PreviewClaimOptions,
): Promise<Result<MintPreviewResult, ProductNftsError>> {
    try {
        const { credit, collections, signal } = options;
        if (!/^0x[0-9a-fA-F]{64}$/.test(credit)) {
            return err(new ProductNftsError("credit must be a 0x-prefixed 32-byte hash"));
        }
        for (const id of collections) {
            if (!isValidId(id)) return err(new NftsIdError(id));
        }
        const snapshot = await pinBlock(chain, signal, options.at);
        if (collections.length === 0) return ok({ at: snapshot, previews: [] });
        const at = readAt(snapshot, signal);
        const query = chain.assetHub.query;

        const result = await chain.assetHub.apis.NftClaimsApi.preview_mints(
            collections.map((collection) => ({ credit, collection })),
            at,
        );
        if (!result.success) {
            // `TooLarge` is the only refusal the runtime declares.
            return err(new ProductNftsError("preview_mints refused the batch as too large"));
        }
        const outcomes = result.value;
        if (outcomes.length !== collections.length) {
            return err(new NftsDecodeError("preview_mints answered a different number of queries"));
        }

        // Metadata for every item that would mint, grouped by collection so each
        // collection costs one exact-key read plus one defaults scan.
        const byCollection = new Map<number, number[]>();
        outcomes.forEach((outcome, index) => {
            if (outcome.type !== "Mints") return;
            const collection = collections[index] as number;
            byCollection.set(collection, [
                ...(byCollection.get(collection) ?? []),
                outcome.value.item,
            ]);
        });
        const resolved = new Map<
            number,
            {
                defaults: Record<string, Uint8Array | { asBytes(): Uint8Array }>;
                items: Map<number, Record<string, Uint8Array | { asBytes(): Uint8Array }>>;
            }
        >();
        await Promise.all(
            [...byCollection.entries()].map(async ([collection, items]) => {
                const [defaultRows, overrides] = await Promise.all([
                    query.Scarcity.CollectionMetadata.getEntries(collection, at),
                    readTypedKeys(query, collection, items, at),
                ]);
                resolved.set(collection, {
                    defaults: collectionBag(defaultRows),
                    items: overrides,
                });
            }),
        );

        const previews = outcomes.map((outcome, index): MintPreview => {
            const collection = collections[index] as number;
            return { collection, outcome: toOutcome(outcome, collection, resolved) };
        });
        return ok({ at: snapshot, previews });
    } catch (cause) {
        return err(matchChainEntryError(cause) ?? normalizeError(cause, ProductNftsError));
    }
}

function toOutcome(
    outcome: RawMintOutcome,
    collection: number,
    resolved: Map<
        number,
        {
            defaults: Record<string, Uint8Array | { asBytes(): Uint8Array }>;
            items: Map<number, Record<string, Uint8Array | { asBytes(): Uint8Array }>>;
        }
    >,
): MintPreview["outcome"] {
    if (outcome.type === "Fails")
        return { tag: "Fails", reason: failureReason(outcome.value.reason) };
    const { item, via } = outcome.value;
    const layers = resolved.get(collection);
    const defaults = layers?.defaults ?? {};
    const raw = layers?.items.get(item) ?? {};
    const decodedDefaults = decodeBag(defaults);
    const decoded = decodeBag(raw);
    return {
        tag: "Mints",
        item,
        via: toItemSelection(via),
        name: decoded.name ?? decodedDefaults.name ?? null,
        rarity: decoded.rarity ?? decodedDefaults.rarity ?? null,
        imageRef: imageRefFrom([defaults, raw]),
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const utf8 = (text: string) => new TextEncoder().encode(text);
    const BLOCK = { hash: `0x${"66".repeat(32)}`, number: 123 };
    const CREDIT = `0x${"c1".repeat(32)}`;

    function fakeChain(state: {
        outcomes?: RawMintOutcome[];
        refuse?: boolean;
        itemMetadata?: Record<string, Array<[string, Uint8Array]>>;
        collectionMetadata?: Record<number, Array<[string, Uint8Array]>>;
    }) {
        const calls: string[] = [];
        let blocks = 0;
        const chain = {
            assetHub: {
                query: {
                    Scarcity: {
                        CollectionMetadata: {
                            getEntries: async (collection: number) => {
                                calls.push(`defaults:${collection}`);
                                return (state.collectionMetadata?.[collection] ?? []).map(
                                    ([k, v]) => ({
                                        keyArgs: [collection, utf8(k)],
                                        value: { value: v },
                                    }),
                                );
                            },
                        },
                        ItemMetadata: {
                            getValues: async (keys: Array<[number, number, Uint8Array]>) => {
                                calls.push(`itemKeys:${keys.length}`);
                                return keys.map(([collection, item, key]) => {
                                    const name = new TextDecoder().decode(key);
                                    const row = state.itemMetadata?.[`${collection}/${item}`]?.find(
                                        ([k]) => k === name,
                                    );
                                    return row === undefined ? undefined : { value: row[1] };
                                });
                            },
                        },
                    },
                },
                apis: {
                    NftClaimsApi: {
                        preview_mints: async (
                            queries: Array<{ credit: string; collection: number }>,
                        ) => {
                            calls.push(`preview:${queries.map((q) => q.collection).join(",")}`);
                            if (state.refuse)
                                return { success: false, value: { type: "TooLarge" } };
                            return { success: true, value: state.outcomes ?? [] };
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

    const mints = (item: number): RawMintOutcome => ({
        type: "Mints",
        value: { item, via: { type: "Random" } },
    });
    const fails = (type: string, value?: unknown): RawMintOutcome => ({
        type: "Fails",
        value: { reason: { type, value } },
    });

    describe("previewClaim", () => {
        test("one call for the batch, answered in the order asked", async () => {
            const { chain, calls } = fakeChain({
                outcomes: [mints(3), fails("NoItems")],
                itemMetadata: {
                    "0/3": [
                        ["name", utf8("Red Panda")],
                        ["rarity", utf8("rare")],
                    ],
                },
                collectionMetadata: { 0: [["name", utf8("Animals")]] },
            });
            const result = await previewClaim(chain, { credit: CREDIT, collections: [0, 5] });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
            expect(result.value.previews).toEqual([
                {
                    collection: 0,
                    outcome: {
                        tag: "Mints",
                        item: 3,
                        via: { tag: "Random" },
                        name: "Red Panda",
                        rarity: "rare",
                        imageRef: null,
                    },
                },
                { collection: 5, outcome: { tag: "Fails", reason: "NoItems" } },
            ]);
            expect(calls.filter((c) => c.startsWith("preview"))).toEqual(["preview:0,5"]);
            // Metadata only for the collection that mints, and only its item.
            expect(calls).toContain("defaults:0");
            expect(calls).not.toContain("defaults:5");
            expect(calls).toContain("itemKeys:3");
        });

        test("collection defaults fill what the item does not set", async () => {
            const { chain } = fakeChain({
                outcomes: [mints(1)],
                collectionMetadata: {
                    2: [
                        ["rarity", utf8("common")],
                        ["image", utf8("bafkcid")],
                    ],
                },
            });
            const result = await previewClaim(chain, { credit: CREDIT, collections: [2] });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const outcome = result.value.previews[0]?.outcome;
            expect(outcome?.tag).toBe("Mints");
            if (outcome?.tag !== "Mints") return;
            expect(outcome.rarity).toBe("common");
            expect(outcome.imageRef?.text).toBe("bafkcid");
        });

        test("a failure reason that carries an item names it", async () => {
            const { chain } = fakeChain({ outcomes: [fails("UnknownItem", { item: 9 })] });
            const result = await previewClaim(chain, { credit: CREDIT, collections: [0] });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.previews[0]?.outcome).toEqual({
                tag: "Fails",
                reason: "UnknownItem 9",
            });
        });

        test("a contract selection is reported as the contract, not as random", async () => {
            const contract = `0x${"ab".repeat(20)}`;
            const { chain } = fakeChain({
                outcomes: [
                    {
                        type: "Mints",
                        value: { item: 2, via: { type: "Contract", value: contract } },
                    },
                ],
            });
            const result = await previewClaim(chain, { credit: CREDIT, collections: [4] });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const outcome = result.value.previews[0]?.outcome;
            expect(outcome?.tag === "Mints" && outcome.via).toEqual({
                tag: "Contract",
                address: contract,
            });
        });

        test("an answer with the wrong number of outcomes is an error, not a misaligned list", async () => {
            const { chain } = fakeChain({ outcomes: [mints(1)] });
            const result = await previewClaim(chain, { credit: CREDIT, collections: [0, 1] });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });

        test("no collections is no round trip past the pin", async () => {
            const { chain, calls } = fakeChain({});
            const result = await previewClaim(chain, { credit: CREDIT, collections: [] });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.previews).toEqual([]);
            expect(calls).toEqual([]);
        });

        test("a refused batch is an error, since nothing was answered", async () => {
            const { chain } = fakeChain({ refuse: true });
            const result = await previewClaim(chain, { credit: CREDIT, collections: [0] });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.message).toContain("too large");
        });

        test("a credit that is not a 32-byte hash is refused before the pin", async () => {
            const { chain, blocks } = fakeChain({});
            const result = await previewClaim(chain, { credit: "0x1234", collections: [0] });
            expect(result.ok).toBe(false);
            expect(blocks()).toBe(0);
        });

        test("a collection id that is not a u32 is refused before the pin", async () => {
            const { chain, blocks } = fakeChain({});
            const result = await previewClaim(chain, { credit: CREDIT, collections: [Number.NaN] });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsIdError);
            expect(blocks()).toBe(0);
        });
    });
}
