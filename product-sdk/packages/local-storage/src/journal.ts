// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Byte-level host storage, and changes to several keys that land whole or not at all.
 *
 * Host storage keeps one value per key, lists no keys and has no transactions,
 * and the host may stop a worker between two writes. A change that spans keys
 * (a record and the index that lists it) therefore goes through a journal: the
 * journal entry is written first, then each key, then the journal is cleared.
 * Opening the store replays a journal left behind, so a stop between two writes
 * never leaves a change half-applied.
 *
 * @module
 */
import { type HostLocalStorage, getHostLocalStorage } from "@parity/product-sdk-host";

/** Host storage as raw bytes. Every write is durable when its promise resolves. */
export interface ByteStore {
    /** The value under `key`, or `undefined` when the key holds none. */
    read(key: string): Promise<Uint8Array | undefined>;
    write(key: string, value: Uint8Array): Promise<void>;
    clear(key: string): Promise<void>;
}

/** A {@link ByteStore} over the host's local storage. */
export function hostByteStore(host: HostLocalStorage): ByteStore {
    return {
        read: (key) => host.readBytes(key),
        write: (key, value) => host.writeBytes(key, value),
        clear: (key) => host.clear(key),
    };
}

/** The host's local storage as a {@link ByteStore}, or `null` outside a container. */
export async function getHostByteStore(): Promise<ByteStore | null> {
    const host = await getHostLocalStorage();
    return host ? hostByteStore(host) : null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toHex(bytes: Uint8Array): string {
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
}

function fromHex(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let index = 0; index < out.length; index++)
        out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return out;
}

/**
 * A record as stored bytes: JSON in which byte arrays are `{ "$b": hex }` and
 * bigints `{ "$n": decimal }`, so records with keys, ids and timestamps round-trip.
 */
export function encodeRecord(value: unknown): Uint8Array {
    return encoder.encode(
        JSON.stringify(value, (_key, item) => {
            if (item instanceof Uint8Array) return { $b: toHex(item) };
            if (typeof item === "bigint") return { $n: item.toString() };
            return item;
        }),
    );
}

/** The record {@link encodeRecord} stored. */
export function decodeRecord<T>(bytes: Uint8Array): T {
    return JSON.parse(decoder.decode(bytes), (_key, item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
            if (typeof item.$b === "string" && Object.keys(item).length === 1)
                return fromHex(item.$b);
            if (typeof item.$n === "string" && Object.keys(item).length === 1)
                return BigInt(item.$n);
        }
        return item;
    }) as T;
}

/** One key of a change: its name under the store's prefix, and its new bytes, or `null` to clear it. */
export type JournalEntry = [name: string, value: Uint8Array | null];

/** Keys under one prefix, written in atomic changes. Obtain one with {@link openJournaledStore}. */
export interface JournaledStore {
    /** The host key of `name`: `<prefix>/<name>`. */
    key(name: string): string;
    /** The bytes under `name`. */
    read(name: string): Promise<Uint8Array | undefined>;
    /** The record under `name`. */
    readRecord<T>(name: string): Promise<T | undefined>;
    /**
     * Writes `entries` as one change, after every change before it. A change of
     * more than one key goes through the journal.
     */
    commit(entries: JournalEntry[]): Promise<void>;
    /** Resolves when every change so far is durable. */
    flush(): Promise<void>;
}

/**
 * Opens the keys under `prefix`, first replaying a change a stopped worker left
 * half-written.
 *
 * @example
 * ```ts
 * const store = await openJournaledStore(kv, "my-product/v1");
 * await store.commit([
 *     ["m/42", encodeRecord(message)],
 *     ["index", encodeRecord(ids)],
 * ]);
 * ```
 */
export async function openJournaledStore(kv: ByteStore, prefix: string): Promise<JournaledStore> {
    const key = (name: string) => `${prefix}/${name}`;
    const journalKey = key("journal");
    const apply = async (entries: JournalEntry[]) => {
        for (const [name, value] of entries) {
            if (value) await kv.write(key(name), value);
            else await kv.clear(key(name));
        }
    };

    const pending = await kv.read(journalKey);
    if (pending) {
        await apply(decodeRecord<JournalEntry[]>(pending));
        await kv.clear(journalKey);
    }

    let writes: Promise<void> = Promise.resolve();
    return {
        key,
        read: (name) => kv.read(key(name)),
        async readRecord<T>(name: string) {
            const bytes = await kv.read(key(name));
            return bytes ? decodeRecord<T>(bytes) : undefined;
        },
        commit(entries) {
            const next = writes.then(async () => {
                if (entries.length > 1) await kv.write(journalKey, encodeRecord(entries));
                await apply(entries);
                if (entries.length > 1) await kv.clear(journalKey);
            });
            writes = next.catch(() => {});
            return next;
        },
        flush: () => writes,
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { MemoryByteStore, WorkerStoppedError } = await import("./testing.js");

    test("records round-trip bytes and bigints", () => {
        const record = {
            id: "m",
            account: new Uint8Array([1, 2]),
            at: 2n ** 70n,
            nested: [{ k: new Uint8Array() }],
        };
        expect(decodeRecord(encodeRecord(record))).toEqual(record);
        expect(new TextDecoder().decode(encodeRecord({ a: new Uint8Array([255]), b: 1n }))).toBe(
            '{"a":{"$b":"ff"},"b":{"$n":"1"}}',
        );
    });

    describe("openJournaledStore", () => {
        test("a stop in the middle of a change is finished on the next open", async () => {
            const kv = new MemoryByteStore();
            const store = await openJournaledStore(kv, "p");
            await store.commit([["a", encodeRecord(0)]]);
            kv.budget = kv.writes + 2; // the journal and one key land, then the worker stops
            await expect(
                store.commit([
                    ["a", encodeRecord(1)],
                    ["b", encodeRecord(1)],
                ]),
            ).rejects.toThrow(WorkerStoppedError);
            const after = kv.snapshot();
            expect(after.data.has("p/journal")).toBe(true);
            const reopened = await openJournaledStore(after, "p");
            expect(await reopened.readRecord("a")).toBe(1);
            expect(await reopened.readRecord("b")).toBe(1);
            expect(after.data.has("p/journal")).toBe(false);
        });

        test("a single-key change writes no journal, and changes apply in order", async () => {
            const kv = new MemoryByteStore();
            const store = await openJournaledStore(kv, "p");
            void store.commit([["a", encodeRecord(1)]]);
            void store.commit([["a", null]]);
            await store.flush();
            expect(kv.data.has("p/a")).toBe(false);
            expect(kv.writes).toBe(2);
        });

        test("a stop before the journal landed loses the change whole", async () => {
            const kv = new MemoryByteStore();
            const store = await openJournaledStore(kv, "p");
            kv.budget = 0;
            await expect(
                store.commit([
                    ["a", encodeRecord(1)],
                    ["b", encodeRecord(1)],
                ]),
            ).rejects.toThrow();
            const reopened = await openJournaledStore(kv.snapshot(), "p");
            expect(await reopened.readRecord("a")).toBeUndefined();
            expect(await reopened.readRecord("b")).toBeUndefined();
        });
    });
}
