// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { CidCodec, parseCid, UnixFsDagBuilder } from "@parity/bulletin-sdk";
import { createLogger } from "@parity/product-sdk-logger";

import type { QueryStrategy } from "./resolve-query.js";
import { resolveQueryStrategy } from "./resolve-query.js";
import type { QueryOptions } from "./types.js";

const log = createLogger("bulletin");

/**
 * Fetch raw bytes for a CID via the host's preimage lookup.
 *
 * Container-only by design: the Cloud Storage SDK does not retrieve content
 * through public IPFS gateways. Inside a Polkadot Browser / Desktop
 * container, the host's `preimageManager` provides a cached, polling-
 * managed lookup that returns bytes when the underlying IPFS network
 * makes them available. Outside a container, this throws
 * {@link CloudStorageHostUnavailableError}.
 *
 * The underlying chain stores transaction *metadata* on-chain
 * (`chunk_root`, `content_hash`, `size`, `cid_codec`, `hashing`) — the
 * content bytes themselves live in IPFS and are surfaced through the
 * host's preimage subscription, never via direct gateway fetch.
 *
 * To prove that a CID was stored on-chain (without fetching the bytes),
 * use `verifyStored` from `verify.ts`.
 *
 * @param cid     - CIDv1 string to fetch.
 * @param options - Query options (`lookupTimeoutMs` for host).
 * @throws {CloudStorageHostUnavailableError} If running outside a container.
 */
export async function queryBytes(cid: string, options?: QueryOptions): Promise<Uint8Array> {
    const strategy = await resolveQueryStrategy();
    return executeQuery(strategy, cid, options);
}

/**
 * Fetch and parse JSON for a CID via the host's preimage lookup.
 *
 * Convenience wrapper over {@link queryBytes}.
 */
export async function queryJson<T>(cid: string, options?: QueryOptions): Promise<T> {
    const bytes = await queryBytes(cid, options);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Execute a query using a pre-resolved strategy.
 *
 * Exposed so `CloudStorageClient` can resolve the strategy once at
 * construction time and reuse it across calls without re-detecting
 * the host environment on every fetch.
 *
 * **Reassembly is automatic.** If `cid` carries the DAG-PB codec
 * (`0x70`) — meaning the upload was chunked and a UnixFS manifest was
 * created — this function recursively fetches each chunk via `strategy
 * .lookup` and returns the concatenated bytes. Pass `noReassemble: true`
 * to get the raw manifest bytes instead.
 *
 * For raw-codec CIDs (`0x55`, single-chunk content), the bytes returned
 * by the host are returned directly — no parsing overhead.
 */
export async function executeQuery(
    strategy: QueryStrategy,
    cid: string,
    options?: QueryOptions,
): Promise<Uint8Array> {
    log.info("query: host preimage lookup", { cid });
    const bytes = await strategy.lookup(cid, options?.lookupTimeoutMs);

    // Skip reassembly when the caller explicitly asks for raw bytes, or
    // when the CID's codec says this is a single-block payload (raw,
    // 0x55) — most uploads land here, so the parseCid + Promise.all
    // overhead is worth gating on codec rather than always paying it.
    if (options?.noReassemble) return bytes;
    const parsed = parseCid(cid);
    if (parsed.code !== CidCodec.DagPb) return bytes;

    log.info("query: reassembling DAG-PB manifest", { cid });
    const builder = new UnixFsDagBuilder();
    const { chunkCids } = await builder.parse(bytes);

    // Fetch chunks in parallel — the host's preimageManager caches and
    // dedupes lookups, and order is preserved by Promise.all's input
    // ordering, which matches the DAG-PB Links order from parse().
    const chunks = await Promise.all(
        chunkCids.map((c) => strategy.lookup(c.toString(), options?.lookupTimeoutMs)),
    );

    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

if (import.meta.vitest) {
    const { beforeAll, describe, test, expect, vi } = import.meta.vitest;
    const { calculateCid } = await import("@parity/bulletin-sdk");

    describe("executeQuery", () => {
        const testData = new Uint8Array([1, 2, 3]);

        test("delegates to the strategy's lookup function", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            // Use a real raw-codec CID so the codec check passes through
            // without triggering reassembly.
            const rawCid = (await calculateCid(testData)).toString();
            const result = await executeQuery(strategy, rawCid);
            expect(result).toBe(testData);
            expect(lookup).toHaveBeenCalledWith(rawCid, undefined);
        });

        test("forwards lookupTimeoutMs to the strategy", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            const rawCid = (await calculateCid(testData)).toString();
            await executeQuery(strategy, rawCid, { lookupTimeoutMs: 5000 });
            expect(lookup).toHaveBeenCalledWith(rawCid, 5000);
        });

        test("returns raw bytes directly for raw-codec CIDs (no reassembly)", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            const rawCid = (await calculateCid(testData)).toString();
            const result = await executeQuery(strategy, rawCid);
            expect(result).toBe(testData);
            // Single lookup, no recursion.
            expect(lookup).toHaveBeenCalledTimes(1);
        });

        test("noReassemble: true short-circuits even for DAG-PB CIDs", async () => {
            // Manufacture a DAG-PB CID; we don't need the bytes to actually
            // be a valid manifest because we're skipping the parse step.
            const fakeManifestBytes = new Uint8Array([10, 20, 30]);
            const dagPbCid = (await calculateCid(fakeManifestBytes, /* dag-pb */ 0x70)).toString();
            const lookup = vi.fn().mockResolvedValue(fakeManifestBytes);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            const result = await executeQuery(strategy, dagPbCid, { noReassemble: true });
            expect(result).toBe(fakeManifestBytes);
            expect(lookup).toHaveBeenCalledTimes(1);
        });

        describe("DAG-PB reassembly", () => {
            // Build a real manifest: two raw chunks, dag-pb root.
            const chunkA = new Uint8Array([0xaa, 0xaa, 0xaa]);
            const chunkB = new Uint8Array([0xbb, 0xbb]);
            let chunkACid: string;
            let chunkBCid: string;
            let manifestBytes: Uint8Array;
            let manifestCid: string;

            beforeAll(async () => {
                const { UnixFsDagBuilder: Builder } = await import("@parity/bulletin-sdk");
                chunkACid = (await calculateCid(chunkA)).toString();
                chunkBCid = (await calculateCid(chunkB)).toString();
                const cidA = await calculateCid(chunkA);
                const cidB = await calculateCid(chunkB);
                const manifest = await new Builder().build([
                    { data: chunkA, cid: cidA, index: 0, totalChunks: 2 },
                    { data: chunkB, cid: cidB, index: 1, totalChunks: 2 },
                ]);
                manifestBytes = manifest.dagBytes;
                manifestCid = manifest.rootCid.toString();
            });

            test("recursively fetches chunks and concatenates", async () => {
                const lookup = vi.fn(async (cid: string) => {
                    if (cid === manifestCid) return manifestBytes;
                    if (cid === chunkACid) return chunkA;
                    if (cid === chunkBCid) return chunkB;
                    throw new Error(`unexpected lookup: ${cid}`);
                });
                const strategy: QueryStrategy = { kind: "host-lookup", lookup };
                const result = await executeQuery(strategy, manifestCid);
                expect(result).toEqual(new Uint8Array([0xaa, 0xaa, 0xaa, 0xbb, 0xbb]));
                // 1 manifest + 2 chunks = 3 lookups.
                expect(lookup).toHaveBeenCalledTimes(3);
            });

            test("forwards lookupTimeoutMs to every chunk lookup", async () => {
                const lookup = vi.fn(async (cid: string, _timeoutMs?: number) => {
                    if (cid === manifestCid) return manifestBytes;
                    if (cid === chunkACid) return chunkA;
                    if (cid === chunkBCid) return chunkB;
                    throw new Error("boom");
                });
                const strategy: QueryStrategy = { kind: "host-lookup", lookup };
                await executeQuery(strategy, manifestCid, { lookupTimeoutMs: 7777 });
                for (const call of lookup.mock.calls) {
                    expect(call[1]).toBe(7777);
                }
            });

            test("preserves chunk order from the manifest", async () => {
                const lookup = vi.fn(async (cid: string) => {
                    if (cid === manifestCid) return manifestBytes;
                    if (cid === chunkACid) return chunkA;
                    if (cid === chunkBCid) return chunkB;
                    throw new Error("boom");
                });
                const strategy: QueryStrategy = { kind: "host-lookup", lookup };
                const result = await executeQuery(strategy, manifestCid);
                // Order matters: chunkA bytes must come before chunkB bytes
                // even though both are fetched in parallel.
                expect(Array.from(result.slice(0, 3))).toEqual([0xaa, 0xaa, 0xaa]);
                expect(Array.from(result.slice(3))).toEqual([0xbb, 0xbb]);
            });
        });
    });
}
