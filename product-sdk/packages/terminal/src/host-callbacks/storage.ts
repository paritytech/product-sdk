// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Core and product storage for the truapi core, as files under the terminal's
 * storage directory: `core/` holds the paired session and keys, `product/` the
 * product's `localStorage`.
 */
import { join } from "node:path";

import { ok, type Result } from "neverthrow";
import type { GenericError, HostLocalStorageChangeItem } from "@parity/truapi";
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

export function createFileProductStorage(storageDir: string): ProductStorage {
    const dir = join(storageDir, "product");
    const name = (key: string) => storageFileName("item", key);
    const watchers = new Map<string, Set<(value: Uint8Array | undefined) => void>>();
    const changed = (key: string, value: Uint8Array | undefined) => {
        for (const notify of watchers.get(key) ?? []) notify(value);
    };

    return {
        read: (key) => readStoredFile(dir, name(key)),
        async write(key, value) {
            await writeStoredFile(dir, name(key), value);
            changed(key, value);
        },
        async clear(key) {
            await removeStoredFile(dir, name(key));
            changed(key, undefined);
        },
        subscribeStorage(key) {
            return {
                [Symbol.asyncIterator]() {
                    // The core reads the first item as the current value, then each change.
                    const pending: Promise<Uint8Array | undefined>[] = [
                        readStoredFile(dir, name(key)),
                    ];
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
    const { mkdtemp, rm } = await import("node:fs/promises");
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
    });
}
