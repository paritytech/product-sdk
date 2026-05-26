// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * File-based StorageAdapter for Node.js environments.
 *
 * Implements the @novasamatech/storage-adapter interface using JSON files
 * in ~/.polkadot-apps/. Node.js doesn't have localStorage, so this
 * provides persistent storage for the SDK's session and secret data.
 */
import type { StorageAdapter } from "@novasamatech/storage-adapter";
import { createLogger } from "@parity/product-sdk-logger";
import { fromPromise } from "neverthrow";
import { join } from "node:path";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";

const log = createLogger("terminal");
const DEFAULT_STORAGE_DIR = join(homedir(), ".polkadot-apps");

/**
 * Compute the storage filename for a given appId+key pair.
 *
 * Exposed (rather than kept private) so the test-session helper in
 * `./testing.ts` can target the same file the live adapter reads from
 * without having to duplicate the sanitization rule.
 */
export function sanitizeKey(appId: string, key: string): string {
    return `${appId}_${key}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function toError(e: unknown): Error {
    return e instanceof Error ? e : new Error(String(e));
}

/**
 * Create a file-based StorageAdapter for use with the host-papp SDK in Node.js.
 *
 * Data is stored as individual JSON files in the given directory
 * (defaults to `~/.polkadot-apps/`).
 */
export function createNodeStorageAdapter(appId: string, storageDir?: string): StorageAdapter {
    const dir = storageDir ?? DEFAULT_STORAGE_DIR;
    let dirCreated = false;
    const subscribers = new Map<string, Set<(value: string | null) => unknown>>();

    function fp(key: string): string {
        return join(dir, `${sanitizeKey(appId, key)}.json`);
    }

    async function ensureDir(): Promise<void> {
        if (dirCreated) return;
        await mkdir(dir, { recursive: true });
        dirCreated = true;
    }

    function notifySubscribers(key: string, value: string | null) {
        const subs = subscribers.get(key);
        if (subs) {
            for (const cb of subs) {
                try {
                    cb(value);
                } catch (e) {
                    log.warn("storage subscriber callback threw", { key, error: e });
                }
            }
        }
    }

    return {
        read(key: string) {
            return fromPromise(
                readFile(fp(key), "utf-8").catch((e) => {
                    // Missing files are expected (a missing key reads as null);
                    // log at debug so consumers can opt in to seeing reads when
                    // diagnosing "why isn't my session loading".
                    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                        log.warn("storage read failed", { key, error: e });
                    } else {
                        log.debug("storage read miss", { key });
                    }
                    return null;
                }),
                toError,
            );
        },

        write(key: string, value: string) {
            return fromPromise(
                ensureDir()
                    .then(() => writeFile(fp(key), value, "utf-8"))
                    .then(() => {
                        notifySubscribers(key, value);
                    }),
                toError,
            ).map(() => undefined as undefined);
        },

        clear(key: string) {
            return fromPromise(
                unlink(fp(key))
                    .catch(() => {})
                    .then(() => {
                        notifySubscribers(key, null);
                    }),
                toError,
            ).map(() => undefined as undefined);
        },

        subscribe(key: string, callback: (value: string | null) => unknown) {
            if (!subscribers.has(key)) {
                subscribers.set(key, new Set());
            }
            subscribers.get(key)!.add(callback);
            return () => {
                subscribers.get(key)?.delete(callback);
            };
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect, beforeEach, afterAll } = import.meta.vitest;
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { configure } = await import("@parity/product-sdk-logger");

    let testDir: string;

    beforeEach(async () => {
        // Silence the logger so tests that exercise the warn paths don't
        // pollute stderr with expected log output.
        configure({ handler: () => {} });
        testDir = await mkdtemp(join(tmpdir(), "terminal-storage-test-"));
    });

    afterAll(async () => {
        // Clean up any remaining test dirs
        try {
            await rm(testDir, { recursive: true });
        } catch {
            /* ignore */
        }
    });

    describe("createNodeStorageAdapter", () => {
        test("read returns null for missing key", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            const result = await store.read("nonexistent");
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBeNull();
        });

        test("write and read round-trip", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            await store.write("key1", "hello");
            const result = await store.read("key1");
            expect(result._unsafeUnwrap()).toBe("hello");
        });

        test("write overwrites existing value", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            await store.write("key1", "first");
            await store.write("key1", "second");
            const result = await store.read("key1");
            expect(result._unsafeUnwrap()).toBe("second");
        });

        test("clear removes key", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            await store.write("key1", "value");
            await store.clear("key1");
            const result = await store.read("key1");
            expect(result._unsafeUnwrap()).toBeNull();
        });

        test("clear is safe for missing key", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            const result = await store.clear("nonexistent");
            expect(result.isOk()).toBe(true);
        });

        test("different appIds are isolated", async () => {
            const storeA = createNodeStorageAdapter("app-a", testDir);
            const storeB = createNodeStorageAdapter("app-b", testDir);
            await storeA.write("key", "from-a");
            await storeB.write("key", "from-b");
            expect((await storeA.read("key"))._unsafeUnwrap()).toBe("from-a");
            expect((await storeB.read("key"))._unsafeUnwrap()).toBe("from-b");
        });

        test("subscribe notifies on write", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            const values: (string | null)[] = [];
            store.subscribe("key1", (v) => values.push(v));

            await store.write("key1", "hello");
            expect(values).toEqual(["hello"]);
        });

        test("subscribe notifies on clear", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            const values: (string | null)[] = [];
            await store.write("key1", "hello");
            store.subscribe("key1", (v) => values.push(v));

            await store.clear("key1");
            expect(values).toEqual([null]);
        });

        test("unsubscribe stops notifications", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            const values: (string | null)[] = [];
            const unsub = store.subscribe("key1", (v) => values.push(v));

            await store.write("key1", "first");
            unsub();
            await store.write("key1", "second");

            expect(values).toEqual(["first"]);
        });

        test("subscriber errors do not break other subscribers", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            const values: string[] = [];
            store.subscribe("key1", () => {
                throw new Error("boom");
            });
            store.subscribe("key1", (v) => {
                if (v) values.push(v);
            });

            await store.write("key1", "hello");
            expect(values).toEqual(["hello"]);
        });

        test("sanitizes special characters in keys", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            await store.write("key/with:special chars!", "value");
            const result = await store.read("key/with:special chars!");
            expect(result._unsafeUnwrap()).toBe("value");
        });

        test("handles JSON values", async () => {
            const store = createNodeStorageAdapter("test", testDir);
            const obj = { name: "test", count: 42, nested: { ok: true } };
            await store.write("json", JSON.stringify(obj));
            const raw = (await store.read("json"))._unsafeUnwrap();
            expect(JSON.parse(raw!)).toEqual(obj);
        });
    });

    describe("toError", () => {
        test("returns Error instances unchanged", () => {
            const original = new TypeError("boom");
            expect(toError(original)).toBe(original);
        });

        test("wraps non-Error string values", () => {
            const result = toError("primitive failure");
            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe("primitive failure");
        });

        test("wraps non-Error nullish values", () => {
            const result = toError(null);
            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe("null");
        });
    });
}
