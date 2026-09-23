// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The one adapter from a {@link LocalKvStore} to the SDK's {@link LocalStorageApi}.
 *
 * Both `createApp` (host-backed store) and `createFakeApp` (in-memory store)
 * build their `localStorage` through here, so the shipped adapter and the test
 * fake cannot drift — which is exactly how `clear()` came to be a no-op in
 * production while the fake emptied (#344). The in-source test below drives one
 * assertion set through this factory over an in-memory store; anything the fake
 * exposes, the real path exposes the same way.
 */
import type { LocalKvStore } from "@parity/product-sdk-local-storage";
import type { LocalStorageApi } from "./types.js";

/** Wrap a {@link LocalKvStore} as the SDK's {@link LocalStorageApi}. */
export function createLocalStorageApi(kv: LocalKvStore): LocalStorageApi {
    return {
        get: (key) => kv.get(key),
        set: (key, value) => kv.set(key, value),
        getJSON: <T>(key: string) => kv.getJSON<T>(key),
        setJSON: <T>(key: string, value: T) => kv.setJSON(key, value),
        remove: (key) => kv.remove(key),
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    /** A minimal in-memory {@link LocalKvStore}, string- and JSON-aware. */
    function memoryKvStore(): LocalKvStore {
        const store = new Map<string, string>();
        return {
            async get(key) {
                return store.get(key) ?? null;
            },
            async set(key, value) {
                store.set(key, value);
            },
            async remove(key) {
                store.delete(key);
            },
            async getJSON<T>(key: string) {
                const raw = store.get(key);
                return raw === undefined ? null : (JSON.parse(raw) as T);
            },
            async setJSON(key, value) {
                store.set(key, JSON.stringify(value));
            },
        };
    }

    describe("createLocalStorageApi", () => {
        test("round-trips strings and JSON, and remove deletes one key", async () => {
            const api = createLocalStorageApi(memoryKvStore());

            await api.set("k", "v");
            await api.setJSON("o", { n: 1 });
            expect(await api.get("k")).toBe("v");
            expect(await api.getJSON("o")).toEqual({ n: 1 });
            expect(await api.get("missing")).toBeNull();

            await api.remove("k");
            expect(await api.get("k")).toBeNull();
            // No clear-all: an untouched key stays.
            expect(await api.getJSON("o")).toEqual({ n: 1 });
        });

        test("exposes exactly the LocalStorageApi surface — no clear()", () => {
            const api = createLocalStorageApi(memoryKvStore());
            expect(Object.keys(api).sort()).toEqual(["get", "getJSON", "remove", "set", "setJSON"]);
        });
    });
}
