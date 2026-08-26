// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `getCollections` — every collection registered to accept claims.
 *
 * Powers a collection picker, so it is driven by the claim registry rather than
 * by the catalogue: `NftClaims.CollectionMinters` is the set a claim can mint
 * into, and a `Scarcity.Collections` record with no minter entry is not
 * claimable no matter how many items it holds. How much that distinction
 * removes is per deployment: one carries six collections and registers one,
 * another registers most of what it carries, so a picker cannot assume either.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { pinBlock, readAt, type NftsChain } from "./chain.js";
import { matchChainEntryError, NftsDecodeError, ProductNftsError } from "./errors.js";
import { decodeMetadataKey, decodeMetadataValue } from "./metadata.js";
import type { ItemSelection, MintCollection, RawMinter } from "./types.js";
import type { FinalizedSnapshot } from "./types.js";

/** What one `getCollections` call returns. */
export interface CollectionsResult {
    at: FinalizedSnapshot;
    collections: MintCollection[];
}

export interface GetCollectionsOptions {
    /**
     * Forwarded into every underlying pull, so an aborted caller stops the whole
     * batch. No deadline is applied here — that belongs to the caller.
     */
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
 * **Names come from storage, not from a runtime API.** The `ScarcityApi`
 * `metadata_batch` this was originally specced against does not exist on live
 * Paseo Next Asset Hub (spec 2000036 exposes 27 runtime APIs; neither
 * `ScarcityApi` nor `NftClaimsApi` is among them). `Scarcity.CollectionMetadata`
 * answers the same question, so nothing here waits on it.
 *
 * @example
 * ```ts
 * const chain = await getChainAPI("paseo");
 * const result = await getCollections(chain);
 * if (result.ok) {
 *     for (const collection of result.value.collections) {
 *         console.log(collection.id, collection.name ?? "(unnamed)", collection.itemCount);
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

        const minters = await query.NftClaims.CollectionMinters.getEntries(at);

        const collections = await Promise.all(
            minters.map(async (minter): Promise<MintCollection> => {
                const id = minter.keyArgs[0];
                const [record, metadata] = await Promise.all([
                    query.Scarcity.Collections.getValue(id, at),
                    query.Scarcity.CollectionMetadata.getEntries(id, at),
                ]);

                const name = metadata.find((e) => decodeMetadataKey(e.keyArgs[1]) === "name");

                return {
                    id,
                    name: name === undefined ? null : decodeMetadataValue(name.value.value),
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

    describe("getCollections", () => {
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

            const result = await getCollections(chain);
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
            const result = await getCollections(fakeChain({}).chain);
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
            const result = await getCollections(chain);
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
            const result = await getCollections(chain);
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
            const result = await getCollections(chain);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.collections.map((c) => c.id)).toEqual([0, 2, 5]);
        });

        test("reads every collection at the pinned block", async () => {
            const { chain, calls } = fakeChain({
                minters: [{ keyArgs: [0], value: { owner: "o", selection: { type: "Random" } } }],
            });
            await getCollections(chain);
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

            const result = await getCollections(chain);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(ProductNftsError);
        });

        test("an aborted signal lands on the err channel", async () => {
            const controller = new AbortController();
            controller.abort();
            const result = await getCollections(fakeChain({}).chain, { signal: controller.signal });
            expect(result.ok).toBe(false);
        });

        test("an unknown selection variant lands on the err channel", async () => {
            const { chain } = fakeChain({
                minters: [{ keyArgs: [0], value: { owner: "o", selection: { type: "Auction" } } }],
            });
            const result = await getCollections(chain);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBeInstanceOf(NftsDecodeError);
        });
    });
}
