// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// Pin checks against a structural chain double: `metadata_batch` and
// `ItemDefs` for the displays, `Instances` for the owners, one block.
import { ss58Encode } from "@parity/product-sdk-address";
import { hexToBytes } from "@parity/product-sdk-crypto";
import {
    MAX_INSTANCES_PER_READ,
    ProductNftsError,
    type RawMetadataLayers,
} from "@parity/product-sdk-nfts";
import { describe, expect, test } from "vitest";

import { ProfileError } from "./errors.js";
import { getPinnedNfts } from "./pins.js";
import type { ProfileNft, ProfileNftsChain } from "./types.js";

const BLOCK = { hash: "0xb10c", number: 100 };
const PURSE = `0x${"ab".repeat(32)}` as const;
const OTHER = `0x${"cd".repeat(32)}` as const;
const purseOwner = ss58Encode(hexToBytes(PURSE.slice(2)), 0);
const otherOwner = ss58Encode(hexToBytes(OTHER.slice(2)), 42);

const pin = (instance: bigint, collection = 7, item = 3): ProfileNft => ({
    instance,
    collection,
    item,
    purse: PURSE,
});

type Minted = { collection: number; item: number };

interface ChainState {
    /** What `metadata_batch` resolves each instance to; absent is not minted. */
    minted: Record<string, Minted>;
    /** What `Instances` answers per instance; absent is no entry. */
    owners: Record<string, string>;
    /** Replace the `Instances` read, to make it fail. */
    instancesRead?: () => Promise<Array<string | undefined>>;
}

function fakeChain(state: ChainState) {
    const batches: bigint[][] = [];
    const ownerReads: Array<{ keys: bigint[]; at: string }> = [];
    let blocks = 0;
    const chain = {
        assetHub: {
            query: {
                Scarcity: {
                    ItemDefs: {
                        getValues: async (keys: Array<[number, number]>) =>
                            keys.map(() => ({
                                supply: 10,
                                live_supply: 9,
                                transferability: { type: "Transferable" },
                            })),
                    },
                    Instances: {
                        getValues: async (keys: Array<[bigint]>, options: { at: string }) => {
                            ownerReads.push({ keys: keys.map(([k]) => k), at: options.at });
                            if (state.instancesRead) return state.instancesRead();
                            return keys.map(([k]) => state.owners[k.toString()]);
                        },
                    },
                },
            },
            apis: {
                ScarcityApi: {
                    // The nfts package asks `{ type: "Instance", value: <id> }` per instance.
                    metadata_batch: async (
                        queries: Array<{ type: string; value: bigint }>,
                    ): Promise<RawMetadataLayers[]> => {
                        batches.push(queries.map((q) => q.value));
                        return queries.map((q) => {
                            const minted = state.minted[q.value.toString()];
                            return {
                                resolved: minted
                                    ? {
                                          type: "Instance",
                                          value: { instance: q.value, ...minted },
                                      }
                                    : undefined,
                                collection: [],
                                item: [],
                                instance: [],
                            };
                        });
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
                getBestBlocks: async () => [BLOCK],
            },
        },
    } as unknown as ProfileNftsChain;
    return { chain, batches, ownerReads, blocks: () => blocks };
}

async function run(chain: ProfileNftsChain, nfts: ProfileNft[]) {
    const r = await getPinnedNfts(chain, nfts);
    if (!r.ok) throw r.error;
    return r.value;
}

describe("getPinnedNfts", () => {
    test("confirms a pin the purse holds, with its display", async () => {
        const { chain, ownerReads } = fakeChain({
            minted: { "9": { collection: 7, item: 3 } },
            owners: { "9": purseOwner },
        });
        const result = await run(chain, [pin(9n)]);
        expect(result.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
        expect(result.dropped).toEqual([]);
        expect(result.pins).toHaveLength(1);
        expect(result.pins[0]?.nft).toEqual(pin(9n));
        expect(result.pins[0]?.display).toMatchObject({
            tag: "Found",
            instance: 9n,
            collection: 7,
            item: 3,
            transferability: "Transferable",
        });
        // The owner is read at the block the displays pinned, by instance key.
        expect(ownerReads).toEqual([{ keys: [9n], at: BLOCK.hash }]);
    });

    test("the owner is compared by account bytes, whatever the SS58 prefix", async () => {
        const { chain } = fakeChain({
            minted: { "9": { collection: 7, item: 3 } },
            owners: { "9": ss58Encode(hexToBytes(PURSE.slice(2)), 42) },
        });
        expect((await run(chain, [pin(9n)])).pins).toHaveLength(1);
    });

    test("drops a pin whose instance another account holds", async () => {
        const { chain } = fakeChain({
            minted: { "9": { collection: 7, item: 3 } },
            owners: { "9": otherOwner },
        });
        const result = await run(chain, [pin(9n)]);
        expect(result.pins).toEqual([]);
        expect(result.dropped).toEqual([{ nft: pin(9n), reason: "Moved" }]);
    });

    test("drops a pin whose instance the chain does not have", async () => {
        const { chain } = fakeChain({ minted: {}, owners: {} });
        const result = await run(chain, [pin(404n)]);
        expect(result.dropped).toEqual([{ nft: pin(404n), reason: "NotFound" }]);
    });

    test("drops a pin minted from another collection or item than it claims", async () => {
        const { chain } = fakeChain({
            minted: { "9": { collection: 7, item: 3 }, "10": { collection: 7, item: 3 } },
            owners: { "9": purseOwner, "10": purseOwner },
        });
        const result = await run(chain, [pin(9n, 8, 3), pin(10n, 7, 4)]);
        expect(result.pins).toEqual([]);
        expect(result.dropped.map((d) => d.reason)).toEqual(["Mismatch", "Mismatch"]);
    });

    test("keeps the record's order across confirmed and dropped pins", async () => {
        const { chain } = fakeChain({
            minted: { "1": { collection: 7, item: 3 }, "3": { collection: 7, item: 3 } },
            owners: { "1": purseOwner, "3": otherOwner },
        });
        const result = await run(chain, [pin(3n), pin(2n), pin(1n)]);
        expect(result.pins.map((p) => p.nft.instance)).toEqual([1n]);
        expect(result.dropped).toEqual([
            { nft: pin(3n), reason: "Moved" },
            { nft: pin(2n), reason: "NotFound" },
        ]);
    });

    test("reads a long list in chunks against the one block the first chunk pinned", async () => {
        const count = MAX_INSTANCES_PER_READ + 2;
        const minted: Record<string, Minted> = {};
        const owners: Record<string, string> = {};
        const nfts: ProfileNft[] = [];
        for (let i = 1; i <= count; i++) {
            minted[String(i)] = { collection: 7, item: 3 };
            owners[String(i)] = purseOwner;
            nfts.push(pin(BigInt(i)));
        }
        const { chain, batches, ownerReads, blocks } = fakeChain({ minted, owners });
        const result = await run(chain, nfts);
        expect(result.pins).toHaveLength(count);
        expect(batches.map((b) => b.length)).toEqual([MAX_INSTANCES_PER_READ, 2]);
        expect(ownerReads.map((r) => r.keys.length)).toEqual([MAX_INSTANCES_PER_READ, 2]);
        expect(ownerReads.every((r) => r.at === BLOCK.hash)).toBe(true);
        expect(blocks()).toBe(1);
    });

    test("an empty list pins a block and reads nothing else", async () => {
        const { chain, batches, ownerReads, blocks } = fakeChain({ minted: {}, owners: {} });
        const result = await run(chain, []);
        expect(result).toEqual({
            at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
            pins: [],
            dropped: [],
        });
        expect(blocks()).toBe(1);
        expect(batches).toEqual([]);
        expect(ownerReads).toEqual([]);
    });

    test("a failed display read is a ChainRead failure with the nfts error as cause", async () => {
        const boom = new Error("metadata_batch unavailable");
        const { chain } = fakeChain({ minted: {}, owners: {} });
        (chain.assetHub.apis.ScarcityApi as { metadata_batch: unknown }).metadata_batch = () =>
            Promise.reject(boom);
        const r = await getPinnedNfts(chain, [pin(9n)]);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toBeInstanceOf(ProfileError);
            expect(r.error.reason).toBe("ChainRead");
            // The nfts package's own error rides on `cause`, and the raw failure
            // one level further down, so a caller can narrow on either.
            expect(r.error.cause).toBeInstanceOf(ProductNftsError);
            expect((r.error.cause as ProductNftsError).cause).toBe(boom);
        }
    });

    test("a failed owner read is a ChainRead failure carrying the cause", async () => {
        const boom = new Error("storage unavailable");
        const { chain } = fakeChain({
            minted: { "9": { collection: 7, item: 3 } },
            owners: {},
            instancesRead: () => Promise.reject(boom),
        });
        const r = await getPinnedNfts(chain, [pin(9n)]);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toBeInstanceOf(ProfileError);
            expect((r.error as ProfileError).reason).toBe("ChainRead");
            expect(r.error.cause).toBe(boom);
        }
    });
});

describe("a pin with a purse that is not an account id", () => {
    test("is InvalidEntry before the chain is asked", async () => {
        const untouched = new Proxy({} as ProfileNftsChain, {
            get() {
                throw new Error("the chain must not be read");
            },
        });
        const result = await getPinnedNfts(untouched, [{ ...pin(1n), purse: "0xabc" as never }]);
        expect(!result.ok && result.error.reason).toBe("InvalidEntry");
    });
});
