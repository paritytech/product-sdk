/**
 * Chain-storage verification for stored CIDs.
 *
 * The bulletin chain doesn't store content bytes on-chain — `TransactionStorage
 * .Transactions[block]` holds metadata only (`{ chunk_root, content_hash,
 * hashing, cid_codec, size, block_chunks }`), and the bytes themselves live
 * in IPFS. So "read by CID from chain" isn't possible. What *is* possible is
 * proving that a given CID was stored: parse the CID's digest + multihash
 * code, then look it up in `TransactionStorage.Transactions` and confirm a
 * matching `content_hash` + `hashing`.
 *
 * Common use case: just-after-upload UX — `await client.store(data).send()`
 * gives you back `{ cid, blockNumber, extrinsicIndex? }`, and a follow-up
 * `verifyStored(api, cid, { block: blockNumber })` confirms the metadata
 * landed where expected.
 */
import { CID } from "multiformats/cid";

import { HashAlgorithm } from "./cid.js";
import { CloudStorageCidError } from "./errors.js";
import type { CloudStorageApi } from "./types.js";

/**
 * Match a multihash code in a CID against the chain's `hashing` enum value.
 */
const HASH_CODE_TO_ENUM_TYPE: Record<number, "Blake2b256" | "Sha2_256" | "Keccak256"> = {
    [HashAlgorithm.Blake2b256]: "Blake2b256",
    [HashAlgorithm.Sha2_256]: "Sha2_256",
    [HashAlgorithm.Keccak256]: "Keccak256",
};

/** A single matched entry from `TransactionStorage.Transactions`. */
export interface ChainStoredEntry {
    /** Block number where the transaction was included. */
    block: number;
    /** Index of the entry within the block's transactions array. */
    index: number;
    /** Size of the stored data in bytes (from chain metadata). */
    size: number;
    /** Number of chunks (1 for unchunked data, >1 for chunked + manifest). */
    blockChunks: number;
}

/**
 * Verification options for {@link verifyStored}.
 */
export interface VerifyStoredOptions {
    /**
     * Block number to look up. Pass the `blockNumber` returned from a prior
     * `store(...).send()` for an O(1) lookup.
     *
     * If omitted, throws — full-chain scans are not supported because
     * `RetentionPeriod` can be many days of blocks. Use `getEntries()` on
     * `api.query.TransactionStorage.Transactions` directly if you need that.
     */
    block: number;
    /**
     * Optional: index within the block. When provided, narrows verification
     * to that exact slot. Useful when re-checking a known `(block, index)`
     * tuple from an earlier receipt.
     */
    index?: number;
}

/**
 * Verify that a CID is recorded in the cloud storage (bulletin chain's `Transactions` storage)
 * at the given block.
 *
 * Returns the matched entry (with block + index) when the CID's content
 * hash and hashing algorithm both match a `Transactions[block]` entry.
 * Returns `null` when no match is found at that block.
 *
 * @param api     - Typed Cloud Storage API instance.
 * @param cid     - CIDv1 string to look up.
 * @param options - Verification target (block number, optional index).
 *
 * @example
 * ```ts
 * const receipt = await client.store(data).send();
 * if (receipt.blockNumber !== undefined) {
 *   const entry = await verifyStored(client.api, receipt.cid!.toString(), {
 *     block: receipt.blockNumber,
 *     index: receipt.extrinsicIndex,
 *   });
 *   if (!entry) console.warn("CID not found in expected block — chain reorg?");
 * }
 * ```
 */
export async function verifyStored(
    api: CloudStorageApi,
    cid: string,
    options: VerifyStoredOptions,
): Promise<ChainStoredEntry | null> {
    const parsed = parseCidForVerify(cid);

    const queryFn = (api as unknown as TransactionsQueryApi).query?.TransactionStorage?.Transactions
        ?.getValue;
    if (!queryFn) {
        throw new Error(
            "CloudStorage API does not expose query.TransactionStorage.Transactions — " +
                "the typed API may be incomplete or the runtime version doesn't match the descriptor.",
        );
    }

    const entries = await queryFn(options.block);
    if (!entries || entries.length === 0) return null;

    // When an explicit index is provided, check that slot directly — no
    // reason to walk the full array just to skip everything else.
    if (options.index !== undefined) {
        const entry = entries[options.index];
        if (entry && matchesEntry(entry, parsed)) {
            return {
                block: options.block,
                index: options.index,
                size: entry.size,
                blockChunks: entry.block_chunks,
            };
        }
        return null;
    }

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (matchesEntry(entry, parsed)) {
            return {
                block: options.block,
                index: i,
                size: entry.size,
                blockChunks: entry.block_chunks,
            };
        }
    }

    return null;
}

interface ParsedCid {
    digest: Uint8Array;
    hashType: "Blake2b256" | "Sha2_256" | "Keccak256";
}

/**
 * Hand-rolled mirror of `TransactionStorage.Transactions[block][n]` — the
 * shape PAPI returns at runtime when you call `query.TransactionStorage
 * .Transactions.getValue(block)`. Defined here (rather than derived from
 * `BulletinTypedApi`) because the typed API surfaces these values through
 * `Anonymize<I…>` codec aliases that aren't ergonomic to inline.
 *
 * **If the bulletin runtime changes the entry shape, update this here too.**
 * Source of truth: `TransactionInfo` in
 * `packages/descriptors/chains/bulletin/generated/dist/common-types.d.ts`
 * (look for `chunk_root: FixedSizeBinary<32>` to anchor it). When the
 * descriptor regenerates and the fields shift, this interface, the
 * `cid_codec`/`hashing` matching in `matchesEntry`, and the
 * `HASH_CODE_TO_ENUM_TYPE` map above all need to be re-validated together.
 *
 * `Uint8Array | { asBytes(): Uint8Array }` covers both the raw and Binary-
 * wrapped shapes the codec can return depending on configuration.
 */
interface ChainEntry {
    chunk_root: { asBytes(): Uint8Array } | Uint8Array;
    content_hash: { asBytes(): Uint8Array } | Uint8Array;
    hashing: { type: "Blake2b256" | "Sha2_256" | "Keccak256" };
    cid_codec: bigint;
    size: number;
    block_chunks: number;
}

interface TransactionsQueryApi {
    query?: {
        TransactionStorage?: {
            Transactions?: {
                getValue: (block: number) => Promise<ChainEntry[] | undefined>;
            };
        };
    };
}

function parseCidForVerify(cid: string): ParsedCid {
    let parsed;
    try {
        parsed = CID.parse(cid);
    } catch {
        throw new CloudStorageCidError(`Invalid CID: ${cid}`, cid);
    }
    if (parsed.version !== 1) {
        throw new CloudStorageCidError(`Expected CIDv1, got CIDv${parsed.version}`, cid);
    }
    const hashType = HASH_CODE_TO_ENUM_TYPE[parsed.multihash.code];
    if (!hashType) {
        throw new CloudStorageCidError(
            `Unsupported hash algorithm 0x${parsed.multihash.code.toString(16)}`,
            cid,
        );
    }
    return { digest: parsed.multihash.digest, hashType };
}

function matchesEntry(entry: ChainEntry, target: ParsedCid): boolean {
    if (entry.hashing.type !== target.hashType) return false;
    const onChainBytes =
        entry.content_hash instanceof Uint8Array
            ? entry.content_hash
            : entry.content_hash.asBytes();
    if (onChainBytes.length !== target.digest.length) return false;
    for (let i = 0; i < onChainBytes.length; i++) {
        if (onChainBytes[i] !== target.digest[i]) return false;
    }
    return true;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    function makeMockApi(getValue: (block: number) => Promise<ChainEntry[] | undefined>) {
        return {
            query: {
                TransactionStorage: {
                    Transactions: { getValue },
                },
            },
        } as unknown as CloudStorageApi;
    }

    function makeEntry(
        digest: Uint8Array,
        hashType: "Blake2b256" | "Sha2_256" | "Keccak256" = "Blake2b256",
        size = 100,
        blockChunks = 1,
    ): ChainEntry {
        return {
            chunk_root: digest,
            content_hash: digest,
            hashing: { type: hashType },
            cid_codec: 0x55n,
            size,
            block_chunks: blockChunks,
        };
    }

    // Build a real CIDv1 (blake2b-256, raw) we can verify against
    async function makeCidWithDigest(digest: Uint8Array, hashCode = 0xb220): Promise<string> {
        const Digest = await import("multiformats/hashes/digest");
        return CID.createV1(0x55, Digest.create(hashCode, digest)).toString();
    }

    describe("verifyStored", () => {
        test("returns entry when CID matches at given block", async () => {
            const digest = new Uint8Array(32).fill(0xab);
            const cid = await makeCidWithDigest(digest);
            const api = makeMockApi(vi.fn().mockResolvedValue([makeEntry(digest)]));

            const result = await verifyStored(api, cid, { block: 100 });
            expect(result).toEqual({ block: 100, index: 0, size: 100, blockChunks: 1 });
        });

        test("returns null when block has no entries", async () => {
            const digest = new Uint8Array(32).fill(0xab);
            const cid = await makeCidWithDigest(digest);
            const api = makeMockApi(vi.fn().mockResolvedValue(undefined));

            const result = await verifyStored(api, cid, { block: 100 });
            expect(result).toBeNull();
        });

        test("returns null when block has entries but none match", async () => {
            const targetDigest = new Uint8Array(32).fill(0xab);
            const otherDigest = new Uint8Array(32).fill(0xcd);
            const cid = await makeCidWithDigest(targetDigest);
            const api = makeMockApi(vi.fn().mockResolvedValue([makeEntry(otherDigest)]));

            const result = await verifyStored(api, cid, { block: 100 });
            expect(result).toBeNull();
        });

        test("returns null when hashing algorithm differs", async () => {
            const digest = new Uint8Array(32).fill(0xab);
            // CID uses blake2b-256, chain entry says sha2-256 with same digest bytes
            const cid = await makeCidWithDigest(digest, 0xb220);
            const api = makeMockApi(vi.fn().mockResolvedValue([makeEntry(digest, "Sha2_256")]));

            const result = await verifyStored(api, cid, { block: 100 });
            expect(result).toBeNull();
        });

        test("finds match at correct index when multiple entries exist", async () => {
            const targetDigest = new Uint8Array(32).fill(0xab);
            const filler = new Uint8Array(32).fill(0xcd);
            const cid = await makeCidWithDigest(targetDigest);
            const api = makeMockApi(
                vi
                    .fn()
                    .mockResolvedValue([
                        makeEntry(filler),
                        makeEntry(filler),
                        makeEntry(targetDigest),
                    ]),
            );

            const result = await verifyStored(api, cid, { block: 100 });
            expect(result?.index).toBe(2);
        });

        test("respects explicit index option", async () => {
            const targetDigest = new Uint8Array(32).fill(0xab);
            const filler = new Uint8Array(32).fill(0xcd);
            const cid = await makeCidWithDigest(targetDigest);
            // Target is at index 2, but caller says index 0 — should not match
            const api = makeMockApi(
                vi
                    .fn()
                    .mockResolvedValue([
                        makeEntry(filler),
                        makeEntry(filler),
                        makeEntry(targetDigest),
                    ]),
            );

            const result = await verifyStored(api, cid, { block: 100, index: 0 });
            expect(result).toBeNull();
        });

        test("returns the entry when explicit index matches", async () => {
            const targetDigest = new Uint8Array(32).fill(0xab);
            const filler = new Uint8Array(32).fill(0xcd);
            const cid = await makeCidWithDigest(targetDigest);
            const api = makeMockApi(
                vi
                    .fn()
                    .mockResolvedValue([
                        makeEntry(filler),
                        makeEntry(filler),
                        makeEntry(targetDigest),
                    ]),
            );

            const result = await verifyStored(api, cid, { block: 100, index: 2 });
            expect(result?.index).toBe(2);
        });

        test("throws CloudStorageCidError on invalid CID", async () => {
            const api = makeMockApi(vi.fn());
            await expect(verifyStored(api, "not-a-cid", { block: 1 })).rejects.toThrow(
                CloudStorageCidError,
            );
        });

        test("throws when api lacks the expected query path", async () => {
            const api = {} as CloudStorageApi;
            const digest = new Uint8Array(32).fill(0xab);
            const cid = await makeCidWithDigest(digest);
            await expect(verifyStored(api, cid, { block: 1 })).rejects.toThrow(
                /does not expose query/,
            );
        });

        test("handles content_hash as a Binary-like wrapper", async () => {
            const digest = new Uint8Array(32).fill(0xab);
            const cid = await makeCidWithDigest(digest);
            const wrapper = { asBytes: () => digest };
            const entry: ChainEntry = {
                chunk_root: wrapper,
                content_hash: wrapper,
                hashing: { type: "Blake2b256" },
                cid_codec: 0x55n,
                size: 50,
                block_chunks: 1,
            };
            const api = makeMockApi(vi.fn().mockResolvedValue([entry]));
            const result = await verifyStored(api, cid, { block: 1 });
            expect(result).toEqual({ block: 1, index: 0, size: 50, blockChunks: 1 });
        });

        test("passes the block number to the storage call", async () => {
            const digest = new Uint8Array(32).fill(0xab);
            const cid = await makeCidWithDigest(digest);
            const getValue = vi.fn().mockResolvedValue([makeEntry(digest)]);
            const api = makeMockApi(getValue);
            await verifyStored(api, cid, { block: 42 });
            expect(getValue).toHaveBeenCalledWith(42);
        });
    });
}
