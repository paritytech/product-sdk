// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The product-subtree public key of `//product//{productId}` (RFC-0022).
 *
 * The request is consent-free and cacheable. The disk layer is what makes that
 * worth having: without it every CLI command would need the phone reachable
 * just to render a product address.
 */
import type { UserSession } from "@novasamatech/host-papp";
import { createLogger } from "@parity/product-sdk-logger";
import { fromHex, toHex } from "@polkadot-api/utils";

import { cacheFilePath, loadJsonCache, saveJsonCache, withFileLock } from "./json-cache.js";

const log = createLogger("terminal");

const CACHE_KIND = "ProductSubtrees";
const CACHE_VERSION = 1;
const SUBTREE_KEY_BYTES = 32;

interface SubtreeCache {
    version: typeof CACHE_VERSION;
    entries: Record<string, string>;
}

/** The promise, not the value: concurrent callers share one round trip. */
const memo = new Map<string, Promise<Uint8Array>>();

export interface ProductSubtreeOptions {
    /** Names the cache file. Defaults to the productId. */
    appId?: string;
    storageDir?: string;
}

/**
 * Keyed by session so a re-pair, or a second wallet account, is not served the
 * previous entry. Cross-user reads are prevented by the 0600 file mode.
 */
function entryKey(session: UserSession, productId: string): string {
    return `${session.id}::${productId}`;
}

async function requestSubtree(session: UserSession, productId: string): Promise<Uint8Array> {
    const result = await session.getProductSubtree(productId);
    if (result.isErr()) {
        throw new Error(`Could not fetch the product subtree key: ${result.error.message}`);
    }
    const key = new Uint8Array(result.value);
    if (key.length !== SUBTREE_KEY_BYTES) {
        throw new Error(
            `Product subtree key must be ${SUBTREE_KEY_BYTES} bytes, got ${key.length}`,
        );
    }
    return key;
}

/**
 * Fetch the subtree public key for `productId`, reaching the wallet only on a
 * cold cache.
 *
 * @throws Error when the wallet rejects the request or returns a malformed key.
 */
export function getProductSubtreePublicKey(
    session: UserSession,
    productId: string,
    options: ProductSubtreeOptions = {},
): Promise<Uint8Array> {
    const path = cacheFilePath(options.appId ?? productId, CACHE_KIND, options.storageDir);
    const key = `${path}::${entryKey(session, productId)}`;

    const inFlight = memo.get(key);
    if (inFlight) return inFlight;

    const pending = resolveSubtree(session, productId, path, entryKey(session, productId));
    memo.set(key, pending);
    // A refusal must not be remembered, or every later call fails without asking.
    pending.catch(() => memo.delete(key));
    return pending;
}

async function resolveSubtree(
    session: UserSession,
    productId: string,
    path: string,
    entry: string,
): Promise<Uint8Array> {
    return withFileLock(path, async () => {
        const cache = await loadJsonCache<SubtreeCache>(
            path,
            CACHE_VERSION,
            "product-subtree cache",
        );
        const stored = readEntry(cache, entry, path);
        if (stored) return stored;

        const fetched = await requestSubtree(session, productId);
        const entries =
            typeof cache?.entries === "object" && cache.entries !== null ? cache.entries : {};
        await saveJsonCache(path, {
            version: CACHE_VERSION,
            entries: { ...entries, [entry]: toHex(fetched) },
        } satisfies SubtreeCache);
        return fetched;
    });
}

/** Trusting a malformed entry would sign as an account the user does not own. */
function readEntry(cache: SubtreeCache | null, entry: string, path: string): Uint8Array | null {
    const stored = cache?.entries?.[entry];
    if (typeof stored !== "string") return null;
    let bytes: Uint8Array;
    try {
        bytes = fromHex(stored);
    } catch {
        bytes = new Uint8Array();
    }
    if (bytes.length === SUBTREE_KEY_BYTES) return bytes;
    log.warn("product-subtree cache entry is malformed; refetching", { path });
    return null;
}

/** @internal The memo outlives a single test otherwise. */
export function clearProductSubtreeMemo(): void {
    memo.clear();
}

if (import.meta.vitest) {
    const { describe, test, expect, beforeEach, vi } = import.meta.vitest;
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ok, err } = await import("neverthrow");

    const SUBTREE = new Uint8Array(32).fill(0xa1);

    let storageDir: string;
    beforeEach(() => {
        clearProductSubtreeMemo();
        storageDir = mkdtempSync(join(tmpdir(), "subtree-cache-"));
        return () => rmSync(storageDir, { recursive: true, force: true });
    });

    function makeSession(getProductSubtree: () => unknown, id = "session-1"): UserSession {
        return {
            id,
            getProductSubtree: vi.fn(async () => getProductSubtree()),
        } as unknown as UserSession;
    }

    describe("getProductSubtreePublicKey", () => {
        test("asks the wallet once, then serves the memo", async () => {
            const session = makeSession(() => ok(SUBTREE));
            const first = await getProductSubtreePublicKey(session, "app.dot", { storageDir });
            const second = await getProductSubtreePublicKey(session, "app.dot", { storageDir });

            expect(first).toEqual(SUBTREE);
            expect(second).toEqual(SUBTREE);
            expect(session.getProductSubtree).toHaveBeenCalledTimes(1);
        });

        test("serves a warm disk cache without the wallet", async () => {
            const warm = makeSession(() => ok(SUBTREE));
            await getProductSubtreePublicKey(warm, "app.dot", { storageDir });

            clearProductSubtreeMemo();
            const cold = makeSession(() => {
                throw new Error("the phone must not be asked");
            });
            const fromDisk = await getProductSubtreePublicKey(cold, "app.dot", { storageDir });

            expect(fromDisk).toEqual(SUBTREE);
            expect(cold.getProductSubtree).not.toHaveBeenCalled();
        });

        test("keeps products and sessions apart", async () => {
            const other = new Uint8Array(32).fill(0xb2);
            const session = makeSession(() => ok(SUBTREE));
            await getProductSubtreePublicKey(session, "app.dot", { storageDir });

            const second = makeSession(() => ok(other), "session-2");
            const secondKey = await getProductSubtreePublicKey(second, "app.dot", { storageDir });
            expect(secondKey).toEqual(other);
            expect(second.getProductSubtree).toHaveBeenCalledTimes(1);
        });

        test("throws when the wallet rejects", async () => {
            const session = makeSession(() => err(new Error("user declined")));
            await expect(
                getProductSubtreePublicKey(session, "app.dot", { storageDir }),
            ).rejects.toThrow(/user declined/);
        });

        test("throws on a malformed key rather than deriving from it", async () => {
            const session = makeSession(() => ok(new Uint8Array(31)));
            await expect(
                getProductSubtreePublicKey(session, "app.dot", { storageDir }),
            ).rejects.toThrow(/32 bytes/);
        });

        test("refetches when the cache file is a different version", async () => {
            const path = cacheFilePath("app.dot", CACHE_KIND, storageDir);
            writeFileSync(
                path,
                JSON.stringify({ version: 999, entries: { "session-1::app.dot": "0xdead" } }),
            );

            const session = makeSession(() => ok(SUBTREE));
            const key = await getProductSubtreePublicKey(session, "app.dot", { storageDir });
            expect(key).toEqual(SUBTREE);
            expect(session.getProductSubtree).toHaveBeenCalledTimes(1);
        });

        test("shares one round trip between concurrent callers", async () => {
            const session = makeSession(() => ok(SUBTREE));
            const keys = await Promise.all([
                getProductSubtreePublicKey(session, "app.dot", { storageDir }),
                getProductSubtreePublicKey(session, "app.dot", { storageDir }),
                getProductSubtreePublicKey(session, "app.dot", { storageDir }),
            ]);

            expect(keys.every((k) => k.every((b, i) => b === SUBTREE[i]))).toBe(true);
            expect(session.getProductSubtree).toHaveBeenCalledTimes(1);
        });

        test("survives parallel fetches that share a cache file", async () => {
            const other = new Uint8Array(32).fill(0xb2);
            const first = makeSession(() => ok(SUBTREE));
            const second = makeSession(() => ok(other), "session-2");

            const [a, b] = await Promise.all([
                getProductSubtreePublicKey(first, "app.dot", { appId: "shared", storageDir }),
                getProductSubtreePublicKey(second, "app.dot", { appId: "shared", storageDir }),
            ]);

            expect(a).toEqual(SUBTREE);
            expect(b).toEqual(other);
            const onDisk = JSON.parse(
                readFileSync(cacheFilePath("shared", CACHE_KIND, storageDir), "utf8"),
            );
            expect(Object.keys(onDisk.entries)).toHaveLength(2);
        });

        test("does not remember a refusal", async () => {
            let refuse = true;
            const session = makeSession(() =>
                refuse ? err(new Error("user declined")) : ok(SUBTREE),
            );

            await expect(
                getProductSubtreePublicKey(session, "app.dot", { storageDir }),
            ).rejects.toThrow(/user declined/);
            refuse = false;
            await expect(
                getProductSubtreePublicKey(session, "app.dot", { storageDir }),
            ).resolves.toEqual(SUBTREE);
        });

        test.each([
            ["not hex", "notahex"],
            ["too short", `0x${"ab".repeat(31)}`],
            ["too long", `0x${"ab".repeat(64)}`],
            ["not a string", 42],
        ])("refetches when a cached entry is %s", async (_label, value) => {
            const path = cacheFilePath("app.dot", CACHE_KIND, storageDir);
            writeFileSync(
                path,
                JSON.stringify({
                    version: CACHE_VERSION,
                    entries: { "session-1::app.dot": value },
                }),
            );

            const session = makeSession(() => ok(SUBTREE), "session-1");
            const key = await getProductSubtreePublicKey(session, "app.dot", { storageDir });
            expect(key).toEqual(SUBTREE);
            expect(session.getProductSubtree).toHaveBeenCalledTimes(1);
        });

        test("refetches when the cache file is corrupt", async () => {
            const path = cacheFilePath("app.dot", CACHE_KIND, storageDir);
            writeFileSync(path, "{ not json");

            const session = makeSession(() => ok(SUBTREE));
            const key = await getProductSubtreePublicKey(session, "app.dot", { storageDir });
            expect(key).toEqual(SUBTREE);
        });
    });
}
