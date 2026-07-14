// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test fakes for `@parity/product-sdk-local-storage`.
 *
 * `createFakeHostLocalStorage` is an in-memory `HostLocalStorage` for
 * `createLocalKvStore({ hostLocalStorage })` — test storage code in Node, no host.
 *
 * @packageDocumentation
 */
import type { HostLocalStorage } from "@parity/product-sdk-host";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A single call recorded against a {@link FakeHostLocalStorage}. */
export interface HostLocalStorageCall {
    method: keyof HostLocalStorage;
    key: string;
    /** The written value, for `write*` calls; absent for reads and `clear`. */
    value?: unknown;
}

/** An in-memory {@link HostLocalStorage} with an inspection surface for tests. */
export interface FakeHostLocalStorage extends HostLocalStorage {
    /** Every call made against this fake, in order. */
    readonly calls: ReadonlyArray<HostLocalStorageCall>;
    /** Clear all stored values and the recorded calls. */
    reset(): void;
}

/** Options for {@link createFakeHostLocalStorage}. */
export interface CreateFakeHostLocalStorageOptions {
    /**
     * Entries to preload, keyed by fully-qualified storage key (including any
     * prefix `createLocalKvStore` applies). Strings are stored as UTF-8 bytes.
     */
    seed?: Record<string, string | Uint8Array>;
}

/**
 * Create an in-memory {@link HostLocalStorage}. Every method is a view over one
 * byte-backed store (a `writeString` reads back via `readBytes`), and missing
 * keys read as the host reports them: `""`, `null`, `undefined`.
 *
 * @example
 * ```ts
 * import { createLocalKvStore } from "@parity/product-sdk-local-storage";
 * import { createFakeHostLocalStorage } from "@parity/product-sdk-local-storage/testing";
 *
 * const kv = await createLocalKvStore({ hostLocalStorage: createFakeHostLocalStorage() });
 * await kv.set("theme", "dark");
 * expect(await kv.get("theme")).toBe("dark");
 * ```
 */
export function createFakeHostLocalStorage(
    options?: CreateFakeHostLocalStorageOptions,
): FakeHostLocalStorage {
    const store = new Map<string, Uint8Array>();
    const calls: HostLocalStorageCall[] = [];

    if (options?.seed) {
        for (const [key, value] of Object.entries(options.seed)) {
            store.set(key, typeof value === "string" ? encoder.encode(value) : value);
        }
    }

    const record = (method: keyof HostLocalStorage, key: string, value?: unknown) => {
        calls.push(value === undefined ? { method, key } : { method, key, value });
    };

    return {
        calls,
        reset() {
            store.clear();
            calls.length = 0;
        },
        async readString(key) {
            record("readString", key);
            const bytes = store.get(key);
            return bytes ? decoder.decode(bytes) : "";
        },
        async writeString(key, value) {
            record("writeString", key, value);
            store.set(key, encoder.encode(value));
        },
        async readJSON(key) {
            record("readJSON", key);
            const bytes = store.get(key);
            if (!bytes || bytes.length === 0) return null;
            return JSON.parse(decoder.decode(bytes));
        },
        async writeJSON(key, value) {
            record("writeJSON", key, value);
            store.set(key, encoder.encode(JSON.stringify(value)));
        },
        async readBytes(key) {
            record("readBytes", key);
            return store.get(key);
        },
        async writeBytes(key, value) {
            record("writeBytes", key, value);
            store.set(key, value);
        },
        async clear(key) {
            record("clear", key);
            store.delete(key);
        },
    } satisfies FakeHostLocalStorage;
}

if (import.meta.vitest) {
    // Round-trip guard: drive the fake through the *real* createLocalKvStore.
    const { describe, test, expect, beforeEach } = import.meta.vitest;
    const { createLocalKvStore } = await import("./kv-store.js");
    const { configure } = await import("@parity/product-sdk-logger");

    beforeEach(() => configure({ handler: () => {} }));

    describe("createFakeHostLocalStorage", () => {
        test("round-trips string and JSON values through the real store", async () => {
            const kv = await createLocalKvStore({
                hostLocalStorage: createFakeHostLocalStorage(),
                prefix: "app",
            });
            await kv.set("theme", "dark");
            await kv.setJSON("prefs", { compact: true });

            expect(await kv.get("theme")).toBe("dark");
            expect(await kv.getJSON("prefs")).toEqual({ compact: true });
            expect(await kv.get("missing")).toBeNull();
        });

        test("reports missing keys the way the host does", async () => {
            const host = createFakeHostLocalStorage();
            expect(await host.readString("nope")).toBe("");
            expect(await host.readJSON("nope")).toBeNull();
            expect(await host.readBytes("nope")).toBeUndefined();
        });

        test("methods are views over one byte-backed store", async () => {
            const host = createFakeHostLocalStorage();
            await host.writeString("k", "hi");
            expect(await host.readBytes("k")).toEqual(new TextEncoder().encode("hi"));

            await host.writeBytes("b", new TextEncoder().encode("bye"));
            expect(await host.readString("b")).toBe("bye");
        });

        test("preloads seed entries under their fully-qualified keys", async () => {
            const kv = await createLocalKvStore({
                hostLocalStorage: createFakeHostLocalStorage({ seed: { "app:theme": "light" } }),
                prefix: "app",
            });
            expect(await kv.get("theme")).toBe("light");
        });

        test("records calls and reset clears state and log", async () => {
            const host = createFakeHostLocalStorage();
            await host.writeString("k", "v");
            await host.readString("k");
            expect(host.calls).toEqual([
                { method: "writeString", key: "k", value: "v" },
                { method: "readString", key: "k" },
            ]);

            host.reset();
            expect(host.calls).toHaveLength(0);
            expect(await host.readString("k")).toBe("");
        });
    });
}
