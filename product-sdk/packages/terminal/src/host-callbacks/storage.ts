// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Core and product storage for the truapi core, as files under the terminal's
 * storage directory: `core/` holds the paired session and keys, `product/` the
 * product's `localStorage`, one directory per product.
 */
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { ok, type Result } from "neverthrow";
import type { GenericError, HostLocalStorageChangeItem, ProductId } from "@parity/truapi";
import { encodeCoreStorageKey, type CoreStorageKey } from "@parity/truapi-host";
import type { WebWorkerHostCallbacks } from "@parity/truapi-host/node";
import { toHex } from "@polkadot-api/utils";

import { readStoredFile, removeStoredFile, storageFileName, writeStoredFile } from "./files.js";

type CoreStorage = WebWorkerHostCallbacks["coreStorage"];
type ProductStorage = WebWorkerHostCallbacks["productStorage"];

export function createFileCoreStorage(storageDir: string): CoreStorage {
    const dir = join(storageDir, "core");
    const name = (key: CoreStorageKey) => storageFileName(key.tag, encodeCoreStorageKey(key));
    return {
        readCoreStorage: (key) => readStoredFile(dir, name(key)),
        writeCoreStorage: (key, value) => writeStoredFile(dir, name(key), value),
        clearCoreStorage: (key) => removeStoredFile(dir, name(key)),
    };
}

/** The core's product-storage key prefix, up to and including its version. */
const PRODUCT_KEY_PREFIX = "truapi:product-storage:v1:";

const utf8 = new TextEncoder();

/**
 * The prefix of every key the core hands the host for `productId`'s values, as
 * `ProductStorageKey::owner_prefix` builds it. The id's UTF-8 length keeps one
 * product's prefix from matching an id that merely starts with it.
 */
export function productOwnerPrefix(productId: string): string {
    return `${PRODUCT_KEY_PREFIX}${utf8.encode(productId).length}:${productId}:`;
}

/** The owner prefix `key` starts with, or `undefined` for a key not in the core's format. */
export function ownerPrefixOf(key: string): string | undefined {
    const match = /^(\d+):/.exec(key.slice(PRODUCT_KEY_PREFIX.length));
    if (!key.startsWith(PRODUCT_KEY_PREFIX) || match === null) return undefined;
    const idStart = utf8.encode(key.slice(0, PRODUCT_KEY_PREFIX.length + match[0].length)).length;
    const idEnd = idStart + Number(match[1]);
    const bytes = utf8.encode(key);
    if (bytes[idEnd] !== 0x3a) return undefined;
    const productId = new TextDecoder().decode(bytes.subarray(idStart, idEnd));
    const prefix = productOwnerPrefix(productId);
    return key.startsWith(prefix) ? prefix : undefined;
}

/** Left in a product's directory by `clearProduct`: its flat values are no longer read. */
const CLEARED_MARKER = "cleared";

/**
 * Product values live in one directory per product, which `clearProduct`
 * empties. Terminals before truapi 0.32.0 kept them flat in `product/`, named
 * by a hash of the key, so a flat file does not name its owner. Flat values are
 * still read and move on their key's next write; `clearProduct` leaves them,
 * and marks the product so it never reads them again.
 */
export function createFileProductStorage(storageDir: string): ProductStorage {
    const dir = join(storageDir, "product");
    const name = (key: string) => storageFileName("item", key);
    const ownerDir = (prefix: string) =>
        join(dir, `owner-${createHash("sha256").update(prefix).digest("hex").slice(0, 32)}`);
    const keyDir = (key: string) => {
        const prefix = ownerPrefixOf(key);
        return prefix === undefined ? dir : ownerDir(prefix);
    };
    const watchers = new Map<string, Set<(value: Uint8Array | undefined) => void>>();
    const changed = (key: string, value: Uint8Array | undefined) => {
        for (const notify of watchers.get(key) ?? []) notify(value);
    };
    const read = async (key: string) => {
        const owned = keyDir(key);
        const value = await readStoredFile(owned, name(key));
        if (value !== undefined || owned === dir) return value;
        if ((await readStoredFile(owned, CLEARED_MARKER)) !== undefined) return undefined;
        // A first write may move the key out of the flat file between the reads.
        return (await readStoredFile(dir, name(key))) ?? readStoredFile(owned, name(key));
    };
    const removeLegacy = async (key: string) => {
        if (keyDir(key) !== dir) await removeStoredFile(dir, name(key));
    };

    return {
        read,
        async write(key, value) {
            await writeStoredFile(keyDir(key), name(key), value);
            await removeLegacy(key);
            changed(key, value);
        },
        async clear(key) {
            // Flat copy first, so a read mid-clear cannot fall back to it.
            await removeLegacy(key);
            await removeStoredFile(keyDir(key), name(key));
            changed(key, undefined);
        },
        async clearProduct(productId) {
            const prefix = productOwnerPrefix(productId);
            const owned = ownerDir(prefix);
            // Marker first, so a read mid-clear cannot fall back to a flat value.
            await writeStoredFile(owned, CLEARED_MARKER, new Uint8Array());
            // Only finished values: a `.partial` belongs to a write in flight.
            for (const entry of await readdir(owned)) {
                if (/^item-[0-9a-f]+\.bin$/.test(entry)) await removeStoredFile(owned, entry);
            }
            for (const key of [...watchers.keys()]) {
                if (key.startsWith(prefix)) changed(key, undefined);
            }
        },
        subscribeStorage(key) {
            return {
                [Symbol.asyncIterator]() {
                    // The core reads the first item as the current value, then each change.
                    const pending: Promise<Uint8Array | undefined>[] = [read(key)];
                    let wake: (() => void) | undefined;
                    let closed = false;
                    const notify = (value: Uint8Array | undefined) => {
                        pending.push(Promise.resolve(value));
                        wake?.();
                    };
                    const keyWatchers = watchers.get(key) ?? new Set();
                    watchers.set(key, keyWatchers.add(notify));
                    const close = () => {
                        closed = true;
                        keyWatchers.delete(notify);
                        if (keyWatchers.size === 0) watchers.delete(key);
                        wake?.();
                    };
                    const done = { value: undefined, done: true } as const;
                    return {
                        async next(): Promise<
                            IteratorResult<Result<HostLocalStorageChangeItem, GenericError>>
                        > {
                            while (pending.length === 0 && !closed) {
                                await new Promise<void>((resolve) => {
                                    wake = resolve;
                                });
                            }
                            if (closed) return done;
                            const value = await pending.shift();
                            return {
                                value: ok({ value: value && (toHex(value) as `0x${string}`) }),
                                done: false,
                            };
                        },
                        async return() {
                            close();
                            return done;
                        },
                    };
                },
            };
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest;
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");

    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "terminal-storage-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    describe("createFileCoreStorage", () => {
        // A restart must find the session the previous run stored.
        test("a fresh instance reads what an earlier one wrote", async () => {
            const key: CoreStorageKey = { tag: "AuthSession" };
            await createFileCoreStorage(dir).writeCoreStorage(key, new Uint8Array([7]));
            expect(await createFileCoreStorage(dir).readCoreStorage(key)).toEqual(
                new Uint8Array([7]),
            );
        });
    });

    describe("createFileProductStorage", () => {
        test("a subscription sees the current value, then each write and clear", async () => {
            const storage = createFileProductStorage(dir);
            await storage.write("theme", new Uint8Array([1]));
            const items = storage.subscribeStorage("theme")[Symbol.asyncIterator]();
            const first = await items.next();
            await storage.write("theme", new Uint8Array([2]));
            const second = await items.next();
            await storage.clear("theme");
            const third = await items.next();
            await items.return?.();
            expect([first, second, third].map((item) => item.value?._unsafeUnwrap())).toEqual([
                { value: "0x01" },
                { value: "0x02" },
                { value: undefined },
            ]);
        });

        const key = (productId: string, local: string) =>
            `${productOwnerPrefix(productId)}${local}`;
        const bytes = (...values: number[]) => new Uint8Array(values);
        const flatDir = () => join(dir, "product");
        const writeFlat = (stored: string, value: Uint8Array) =>
            writeStoredFile(flatDir(), storageFileName("item", stored), value);

        // truapi 0.32.0 clears a product's storage when it clears the product's state.
        test("clearProduct removes the product's values, tells subscribers, keeps another product's", async () => {
            const storage = createFileProductStorage(dir);
            await storage.write(key("app.dot", "a"), bytes(1));
            await storage.write(key("other.dot", "a"), bytes(2));
            const items = storage.subscribeStorage(key("app.dot", "a"))[Symbol.asyncIterator]();
            await items.next();
            await storage.clearProduct("app.dot" as ProductId);
            expect((await items.next()).value?._unsafeUnwrap()).toEqual({ value: undefined });
            await items.return?.();
            expect(await storage.read(key("app.dot", "a"))).toBeUndefined();
            expect(await storage.read(key("other.dot", "a"))).toEqual(bytes(2));
        });

        // A write in flight keeps its temporary file until it renames it into place.
        test("clearProduct leaves another call's half-written file alone", async () => {
            const storage = createFileProductStorage(dir);
            await storage.write(key("app.dot", "a"), bytes(1));
            const [owner] = (await readdir(flatDir())).filter((entry) =>
                entry.startsWith("owner-"),
            );
            const partial = "item-0.bin.1234.partial";
            await writeStoredFile(join(flatDir(), String(owner)), partial, bytes(2));
            await storage.clearProduct("app.dot" as ProductId);
            expect(await readdir(join(flatDir(), String(owner)))).toContain(partial);
        });

        // Terminals before truapi 0.32.0 kept every product value flat in `product/`.
        test("reads a flat value an older terminal wrote, moves it on write, hides it once cleared", async () => {
            const stored = key("app.dot", "theme");
            await writeFlat(stored, bytes(9));
            const storage = createFileProductStorage(dir);
            expect(await storage.read(stored)).toEqual(bytes(9));
            await storage.write(stored, bytes(10));
            const files = await readdir(flatDir(), { withFileTypes: true });
            expect(files.filter((entry) => entry.isFile())).toEqual([]);

            // A flat file does not name its owner, so another product's stays.
            const hidden = key("app.dot", "other");
            const kept = key("other.dot", "theme");
            await writeFlat(hidden, bytes(1));
            await writeFlat(kept, bytes(2));
            await storage.clearProduct("app.dot" as ProductId);
            expect(await storage.read(stored)).toBeUndefined();
            expect(await storage.read(hidden)).toBeUndefined();
            expect(await storage.read(kept)).toEqual(bytes(2));
            await storage.write(hidden, bytes(3));
            expect(await storage.read(hidden)).toEqual(bytes(3));
        });
    });

    test("ownerPrefixOf reads the core's length-prefixed owner, in UTF-8 bytes", () => {
        expect(productOwnerPrefix("é.dot")).toBe("truapi:product-storage:v1:6:é.dot:");
        expect(ownerPrefixOf("truapi:product-storage:v1:6:é.dot:k")).toBe(
            productOwnerPrefix("é.dot"),
        );
        // An id containing ':' is read by its length, never as a shorter id.
        expect(ownerPrefixOf(`${productOwnerPrefix("app.dot:x")}k`)).toBe(
            productOwnerPrefix("app.dot:x"),
        );
        for (const bad of [
            "theme",
            "truapi:product-storage:v1:99:a:k",
            "truapi:product-storage:v1:x:a:k",
        ]) {
            expect(ownerPrefixOf(bad)).toBeUndefined();
        }
    });
}
