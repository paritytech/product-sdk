// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Persistent allowance-key cache. One JSON file per `appId`, 0o600.
 *
 * Cache key is the variant tag, except `SmartContractAllowance::{dest}`
 * which disambiguates per-derivation-index PGAS pre-warming.
 *
 * @internal
 */
import { createLogger } from "@parity/product-sdk-logger";
import { toHex } from "@polkadot-api/utils";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AllocatableResource, ApAllocationOutcome } from "./host.js";

const log = createLogger("terminal");

const DEFAULT_STORAGE_DIR = join(homedir(), ".polkadot-apps");
const CACHE_FILE_MODE = 0o600;

/** One cached allowance entry. Hex strings are 0x-prefixed. */
export type CachedAllocation =
    | { tag: "BulletInAllowance"; slotAccountKey: string }
    | { tag: "StatementStoreAllowance"; slotAccountKey: string }
    | { tag: "SmartContractAllowance"; dest: number }
    | {
          tag: "AutoSigning";
          productDerivationSecret: string;
          productRootPrivateKey: string;
      };

interface AllowanceCacheV1 {
    version: 1;
    entries: Record<string, CachedAllocation>;
}

function sanitizeAppId(appId: string): string {
    return appId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function cachePath(appId: string, storageDir?: string): string {
    return join(storageDir ?? DEFAULT_STORAGE_DIR, `${sanitizeAppId(appId)}_AllowanceKeys.json`);
}

function emptyCache(): AllowanceCacheV1 {
    return { version: 1, entries: {} };
}

export async function loadCache(appId: string, storageDir?: string): Promise<AllowanceCacheV1> {
    const path = cachePath(appId, storageDir);
    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return emptyCache();
        throw e;
    }
    try {
        const parsed = JSON.parse(raw) as AllowanceCacheV1;
        if (
            parsed?.version !== 1 ||
            typeof parsed.entries !== "object" ||
            parsed.entries === null
        ) {
            log.warn("allowance cache schema mismatch; starting fresh", { appId, path });
            return emptyCache();
        }
        return parsed;
    } catch (e) {
        log.warn("allowance cache parse failed; starting fresh", { appId, path, error: String(e) });
        return emptyCache();
    }
}

export async function saveCache(
    appId: string,
    cache: AllowanceCacheV1,
    storageDir?: string,
): Promise<void> {
    const path = cachePath(appId, storageDir);
    await mkdir(dirname(path), { recursive: true });
    // Temp + rename so a mid-write crash can't leave a half-written file.
    // Concurrent Hosts: the Account Holder serializes per (user, product,
    // resource) and returns the same key to all callers, so racing writes
    // converge on identical bytes.
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2), { mode: CACHE_FILE_MODE });
    await rename(tmp, path);
}

export function cacheKey(resource: AllocatableResource): string {
    if (resource.tag === "SmartContractAllowance") {
        return `${resource.tag}::${resource.value}`;
    }
    return resource.tag;
}

/**
 * Pick the wire `onExisting` policy from current cache state. `Ignore`
 * unless every requested resource is a slot-table variant (Bulletin /
 * SSS) AND already cached, in which case `Increase`. SC and AutoSigning
 * aren't slot-additive so they always force `Ignore`.
 */
export function pickOnExistingPolicy(
    cache: AllowanceCacheV1,
    resources: AllocatableResource[],
): "Ignore" | "Increase" {
    if (resources.length === 0) return "Ignore";
    const allSlotTableAndCached = resources.every((r) => {
        if (r.tag !== "BulletInAllowance" && r.tag !== "StatementStoreAllowance") return false;
        return Object.hasOwn(cache.entries, cacheKey(r));
    });
    return allSlotTableAndCached ? "Increase" : "Ignore";
}

/**
 * Merge `Allocated` outcomes into the cache. Non-`Allocated` outcomes
 * leave the cache unchanged. Returns the input `cache` reference rather
 * than a copy when no entry was added, so callers can short-circuit a
 * disk write via reference equality.
 *
 * Throws on length mismatch — `outcomes` must be length-matched with
 * `requested`. A divergence is a wire contract violation, not data to
 * silently truncate.
 */
export function mergeOutcomes(
    cache: AllowanceCacheV1,
    requested: AllocatableResource[],
    outcomes: ApAllocationOutcome[],
): AllowanceCacheV1 {
    if (requested.length !== outcomes.length) {
        throw new Error(
            `mergeOutcomes: length mismatch — requested ${requested.length}, got ${outcomes.length}`,
        );
    }
    const entries = { ...cache.entries };
    let mutated = false;
    for (let i = 0; i < outcomes.length; i++) {
        const req = requested[i];
        const out = outcomes[i];
        if (out.tag !== "Allocated") continue;
        const inner = out.value;
        // outcomes must align positionally AND by variant with the request.
        // A divergence is a wire contract violation: throw rather than
        // silently miscaching a key under the wrong cache slot.
        if (inner.tag !== req.tag) {
            throw new Error(
                `mergeOutcomes: variant mismatch at index ${i} — requested ${req.tag}, got Allocated<${inner.tag}>`,
            );
        }
        const key = cacheKey(req);
        switch (inner.tag) {
            case "BulletInAllowance":
            case "StatementStoreAllowance":
                entries[key] = {
                    tag: inner.tag,
                    slotAccountKey: toHex(inner.value.slotAccountKey),
                };
                mutated = true;
                break;
            case "SmartContractAllowance":
                // dest comes from the request; the response payload is undefined.
                // Variant alignment is enforced above, so req.tag is guaranteed
                // to be SmartContractAllowance here — the cast narrows it.
                if (req.tag === "SmartContractAllowance") {
                    entries[key] = { tag: "SmartContractAllowance", dest: req.value };
                    mutated = true;
                }
                break;
            case "AutoSigning":
                entries[key] = {
                    tag: "AutoSigning",
                    productDerivationSecret: inner.value.productDerivationSecret,
                    productRootPrivateKey: toHex(inner.value.productRootPrivateKey),
                };
                mutated = true;
                break;
        }
    }
    return mutated ? { version: 1, entries } : cache;
}

/** Look up a single cached allocation, or `null` if absent. */
export function readCacheEntry(
    cache: AllowanceCacheV1,
    resource: AllocatableResource,
): CachedAllocation | null {
    return cache.entries[cacheKey(resource)] ?? null;
}

/**
 * Serialize load/merge/save sequences for the same cache file within a
 * single process. Without this, parallel `requestResourceAllocation`
 * calls for *different* resources can race: each snapshots the cache
 * before the other writes, last writer wins, the loser's key is lost.
 *
 * Cross-process races are out of scope here — the Account Holder
 * serializes per user/product/resource and returns identical bytes
 * to concurrent callers for the same resource, so two CLI processes
 * writing the same key converge.
 */
const cacheLocks = new Map<string, Promise<unknown>>();

export function withCacheLock<T>(
    appId: string,
    storageDir: string | undefined,
    fn: () => Promise<T>,
): Promise<T> {
    const key = cachePath(appId, storageDir);
    const prev = cacheLocks.get(key) ?? Promise.resolve();
    // Neutralize a prior rejection so one failure doesn't block subsequent waiters.
    const next = prev.catch(() => {}).then(fn);
    cacheLocks.set(
        key,
        next.catch(() => {}),
    );
    return next;
}

if (import.meta.vitest) {
    const { describe, test, expect, beforeEach } = import.meta.vitest;
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    let storageDir: string;
    beforeEach(() => {
        storageDir = mkdtempSync(join(tmpdir(), "host-cache-test-"));
        return () => rmSync(storageDir, { recursive: true, force: true });
    });

    describe("cacheKey", () => {
        test("returns the variant tag for slot-table resources and AutoSigning", () => {
            expect(cacheKey({ tag: "BulletInAllowance", value: undefined })).toBe(
                "BulletInAllowance",
            );
            expect(cacheKey({ tag: "StatementStoreAllowance", value: undefined })).toBe(
                "StatementStoreAllowance",
            );
            expect(cacheKey({ tag: "AutoSigning", value: undefined })).toBe("AutoSigning");
        });

        test("disambiguates SmartContractAllowance by dest", () => {
            expect(cacheKey({ tag: "SmartContractAllowance", value: 0 })).toBe(
                "SmartContractAllowance::0",
            );
            expect(cacheKey({ tag: "SmartContractAllowance", value: 7 })).toBe(
                "SmartContractAllowance::7",
            );
        });
    });

    describe("loadCache / saveCache round-trip", () => {
        test("loadCache on missing file returns empty cache, not an error", async () => {
            const cache = await loadCache("my-app", storageDir);
            expect(cache).toEqual({ version: 1, entries: {} });
        });

        test("saveCache then loadCache returns the same content", async () => {
            const original: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: "0xdeadbeef" },
                },
            };
            await saveCache("my-app", original, storageDir);
            const reloaded = await loadCache("my-app", storageDir);
            expect(reloaded).toEqual(original);
        });

        test("two appIds in the same storageDir don't collide", async () => {
            const a: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: "0x01" },
                },
            };
            const b: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: "0x02" },
                },
            };
            await saveCache("app-a", a, storageDir);
            await saveCache("app-b", b, storageDir);
            expect((await loadCache("app-a", storageDir)).entries.BulletInAllowance).toEqual(
                a.entries.BulletInAllowance,
            );
            expect((await loadCache("app-b", storageDir)).entries.BulletInAllowance).toEqual(
                b.entries.BulletInAllowance,
            );
        });

        test("appId with non-alphanumeric characters sanitizes to a safe path", async () => {
            // Verifies a path-traversal-style appId can't escape storageDir.
            const cache: AllowanceCacheV1 = { version: 1, entries: {} };
            await expect(saveCache("../escape", cache, storageDir)).resolves.toBeUndefined();
            const reloaded = await loadCache("../escape", storageDir);
            expect(reloaded).toEqual(cache);
        });

        test("malformed cache file is treated as empty, not thrown", async () => {
            await writeFile(cachePath("my-app", storageDir), "{ not valid json", "utf-8");
            const cache = await loadCache("my-app", storageDir);
            expect(cache).toEqual({ version: 1, entries: {} });
        });

        test("version mismatch is treated as empty, not thrown", async () => {
            await writeFile(
                cachePath("my-app", storageDir),
                JSON.stringify({ version: 99, entries: {} }),
                "utf-8",
            );
            const cache = await loadCache("my-app", storageDir);
            expect(cache).toEqual({ version: 1, entries: {} });
        });

        test("file is written with 0o600 permissions (defense-in-depth)", async () => {
            const { stat } = await import("node:fs/promises");
            const cache: AllowanceCacheV1 = { version: 1, entries: {} };
            await saveCache("my-app", cache, storageDir);
            const s = await stat(cachePath("my-app", storageDir));
            // Mask to permission bits only — file type bits are above 0o777.
            expect(s.mode & 0o777).toBe(0o600);
        });
    });

    describe("pickOnExistingPolicy", () => {
        test("empty request resolves to Ignore", () => {
            const cache = emptyCache();
            expect(pickOnExistingPolicy(cache, [])).toBe("Ignore");
        });

        test("no cached entries → Ignore", () => {
            const cache = emptyCache();
            expect(
                pickOnExistingPolicy(cache, [{ tag: "BulletInAllowance", value: undefined }]),
            ).toBe("Ignore");
        });

        test("all slot-table resources cached → Increase", () => {
            const cache: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: "0x01" },
                    StatementStoreAllowance: {
                        tag: "StatementStoreAllowance",
                        slotAccountKey: "0x02",
                    },
                },
            };
            expect(
                pickOnExistingPolicy(cache, [
                    { tag: "BulletInAllowance", value: undefined },
                    { tag: "StatementStoreAllowance", value: undefined },
                ]),
            ).toBe("Increase");
        });

        test("mixed cached + uncached → Ignore (conservative)", () => {
            const cache: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: "0x01" },
                },
            };
            expect(
                pickOnExistingPolicy(cache, [
                    { tag: "BulletInAllowance", value: undefined },
                    { tag: "StatementStoreAllowance", value: undefined },
                ]),
            ).toBe("Ignore");
        });

        test("AutoSigning in the request → Ignore even if cached (not slot-additive)", () => {
            const cache: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    AutoSigning: {
                        tag: "AutoSigning",
                        productDerivationSecret: "x",
                        productRootPrivateKey: "0xaa",
                    },
                },
            };
            expect(pickOnExistingPolicy(cache, [{ tag: "AutoSigning", value: undefined }])).toBe(
                "Ignore",
            );
        });

        test("SC in the request → Ignore (not slot-additive; PGAS claim is per-call)", () => {
            const cache: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    "SmartContractAllowance::5": { tag: "SmartContractAllowance", dest: 5 },
                },
            };
            expect(pickOnExistingPolicy(cache, [{ tag: "SmartContractAllowance", value: 5 }])).toBe(
                "Ignore",
            );
        });
    });

    describe("mergeOutcomes", () => {
        test("ignores Rejected and NotAvailable", () => {
            const cache = emptyCache();
            const requested: AllocatableResource[] = [
                { tag: "BulletInAllowance", value: undefined },
                { tag: "StatementStoreAllowance", value: undefined },
            ];
            const outcomes: ApAllocationOutcome[] = [
                { tag: "Rejected", value: undefined },
                { tag: "NotAvailable", value: undefined },
            ];
            const merged = mergeOutcomes(cache, requested, outcomes);
            expect(merged.entries).toEqual({});
        });

        test("stores Allocated Bulletin/SSS keys with hex encoding", () => {
            const cache = emptyCache();
            const requested: AllocatableResource[] = [
                { tag: "BulletInAllowance", value: undefined },
            ];
            const outcomes: ApAllocationOutcome[] = [
                {
                    tag: "Allocated",
                    value: {
                        tag: "BulletInAllowance",
                        value: { slotAccountKey: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
                    },
                },
            ];
            const merged = mergeOutcomes(cache, requested, outcomes);
            expect(merged.entries.BulletInAllowance).toEqual({
                tag: "BulletInAllowance",
                slotAccountKey: "0xdeadbeef",
            });
        });

        test("stores SmartContractAllowance with dest from the request", () => {
            const cache = emptyCache();
            const requested: AllocatableResource[] = [{ tag: "SmartContractAllowance", value: 7 }];
            const outcomes: ApAllocationOutcome[] = [
                {
                    tag: "Allocated",
                    value: { tag: "SmartContractAllowance", value: undefined },
                },
            ];
            const merged = mergeOutcomes(cache, requested, outcomes);
            expect(merged.entries["SmartContractAllowance::7"]).toEqual({
                tag: "SmartContractAllowance",
                dest: 7,
            });
        });

        test("stores AutoSigning subtree key + secret", () => {
            const cache = emptyCache();
            const requested: AllocatableResource[] = [{ tag: "AutoSigning", value: undefined }];
            const outcomes: ApAllocationOutcome[] = [
                {
                    tag: "Allocated",
                    value: {
                        tag: "AutoSigning",
                        value: {
                            productDerivationSecret: "secret-hex",
                            productRootPrivateKey: new Uint8Array([0xab, 0xcd]),
                        },
                    },
                },
            ];
            const merged = mergeOutcomes(cache, requested, outcomes);
            expect(merged.entries.AutoSigning).toEqual({
                tag: "AutoSigning",
                productDerivationSecret: "secret-hex",
                productRootPrivateKey: "0xabcd",
            });
        });

        test("returns the same cache reference when no Allocated outcomes (no-op)", () => {
            // Lets callers gate disk writes on reference equality.
            const cache: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: "0xaa" },
                },
            };
            const requested: AllocatableResource[] = [
                { tag: "BulletInAllowance", value: undefined },
                { tag: "StatementStoreAllowance", value: undefined },
            ];
            const outcomes: ApAllocationOutcome[] = [
                { tag: "Rejected", value: undefined },
                { tag: "NotAvailable", value: undefined },
            ];
            expect(mergeOutcomes(cache, requested, outcomes)).toBe(cache);
        });

        test("empty inputs return the same cache reference", () => {
            const cache = emptyCache();
            expect(mergeOutcomes(cache, [], [])).toBe(cache);
        });

        test("returns a new object reference when at least one entry is added", () => {
            const cache = emptyCache();
            const requested: AllocatableResource[] = [
                { tag: "BulletInAllowance", value: undefined },
            ];
            const outcomes: ApAllocationOutcome[] = [
                {
                    tag: "Allocated",
                    value: {
                        tag: "BulletInAllowance",
                        value: { slotAccountKey: new Uint8Array([1]) },
                    },
                },
            ];
            expect(mergeOutcomes(cache, requested, outcomes)).not.toBe(cache);
        });

        test("throws when outcomes do not length-match requested", () => {
            const cache = emptyCache();
            const requested: AllocatableResource[] = [
                { tag: "BulletInAllowance", value: undefined },
                { tag: "StatementStoreAllowance", value: undefined },
            ];
            const outcomes: ApAllocationOutcome[] = [{ tag: "Rejected", value: undefined }];
            expect(() => mergeOutcomes(cache, requested, outcomes)).toThrow(/length mismatch/);
        });

        test("throws when an Allocated outcome's variant does not match the requested variant", () => {
            // outcomes must align positionally AND by variant with the
            // request. Without this guard, a Bulletin key would get stored
            // under the StatementStoreAllowance cache slot.
            const cache = emptyCache();
            const requested: AllocatableResource[] = [
                { tag: "StatementStoreAllowance", value: undefined },
            ];
            const outcomes: ApAllocationOutcome[] = [
                {
                    tag: "Allocated",
                    value: {
                        tag: "BulletInAllowance",
                        value: { slotAccountKey: new Uint8Array([0xaa]) },
                    },
                },
            ];
            expect(() => mergeOutcomes(cache, requested, outcomes)).toThrow(
                /variant mismatch at index 0 — requested StatementStoreAllowance, got Allocated<BulletInAllowance>/,
            );
        });

        test("preserves existing entries when merging new ones", () => {
            const cache: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    StatementStoreAllowance: {
                        tag: "StatementStoreAllowance",
                        slotAccountKey: "0xaa",
                    },
                },
            };
            const requested: AllocatableResource[] = [
                { tag: "BulletInAllowance", value: undefined },
            ];
            const outcomes: ApAllocationOutcome[] = [
                {
                    tag: "Allocated",
                    value: {
                        tag: "BulletInAllowance",
                        value: { slotAccountKey: new Uint8Array([0xbb]) },
                    },
                },
            ];
            const merged = mergeOutcomes(cache, requested, outcomes);
            expect(Object.keys(merged.entries).sort()).toEqual([
                "BulletInAllowance",
                "StatementStoreAllowance",
            ]);
            expect(merged.entries.StatementStoreAllowance).toEqual({
                tag: "StatementStoreAllowance",
                slotAccountKey: "0xaa",
            });
        });
    });

    describe("readCacheEntry", () => {
        test("returns the cached entry by resource discriminator", () => {
            const cache: AllowanceCacheV1 = {
                version: 1,
                entries: {
                    "SmartContractAllowance::5": {
                        tag: "SmartContractAllowance",
                        dest: 5,
                    },
                },
            };
            expect(readCacheEntry(cache, { tag: "SmartContractAllowance", value: 5 })).toEqual({
                tag: "SmartContractAllowance",
                dest: 5,
            });
            // Different dest doesn't match.
            expect(readCacheEntry(cache, { tag: "SmartContractAllowance", value: 6 })).toBeNull();
        });

        test("returns null when nothing cached", () => {
            const cache = emptyCache();
            expect(
                readCacheEntry(cache, { tag: "BulletInAllowance", value: undefined }),
            ).toBeNull();
        });
    });

    describe("withCacheLock", () => {
        test("serializes calls for the same (appId, storageDir)", async () => {
            const order: string[] = [];
            const a = withCacheLock("app", storageDir, async () => {
                order.push("a-start");
                await new Promise((r) => setTimeout(r, 10));
                order.push("a-end");
            });
            const b = withCacheLock("app", storageDir, async () => {
                order.push("b-start");
                order.push("b-end");
            });
            await Promise.all([a, b]);
            expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
        });

        test("different (appId, storageDir) keys do not block each other", async () => {
            let bRan = false;
            const a = withCacheLock("app-a", storageDir, async () => {
                // b should run while a is still inside the await
                await new Promise((r) => setTimeout(r, 20));
                expect(bRan).toBe(true);
            });
            const b = withCacheLock("app-b", storageDir, async () => {
                bRan = true;
            });
            await Promise.all([a, b]);
        });

        test("a rejection in one call does not block subsequent calls on the same key", async () => {
            const a = withCacheLock("app", storageDir, async () => {
                throw new Error("boom");
            });
            await expect(a).rejects.toThrow("boom");
            const b = await withCacheLock("app", storageDir, async () => "ok");
            expect(b).toBe("ok");
        });
    });
}
