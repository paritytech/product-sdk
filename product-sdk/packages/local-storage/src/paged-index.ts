// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Indexes and claim sets over host storage, which lists no keys.
 *
 * A {@link PagedIndex} lists the ids of one collection (the messages of a chat)
 * with their display order and a few flags, in pages of 256 entries, so adding an
 * entry rewrites one page and opening a collection reads its pages only, not its
 * records. A {@link ClaimSet} remembers which ids had a one-time effect (a message
 * processed, a push sent), in 32 buckets.
 *
 * Both return the {@link JournalEntry} list of a change instead of writing it, so the
 * owner commits it together with the records it belongs to.
 *
 * @module
 */
import { type JournalEntry, type JournaledStore, encodeRecord } from "./journal.js";

/** Entries per index page. */
export const INDEX_PAGE_SIZE = 256;

/** One id of an index: the id, its display order, and the owner's flags. */
export type IndexEntry = [id: string, order: number, flags: number];

/**
 * The ids of one collection under `<name>/<page>`. The owner keeps the page count
 * (`pages()`) with its own metadata, since nothing can list the pages.
 */
export class PagedIndex {
    private readonly list: IndexEntry[];
    private readonly positions = new Map<string, number>();

    /** An index under `name` holding `entries` in display order. */
    constructor(
        readonly name: string,
        entries: IndexEntry[] = [],
    ) {
        this.list = entries;
        entries.forEach(([id], position) => this.positions.set(id, position));
    }

    /** The stored pages of `name`, flattened, as read: entries, or whatever an older format wrote. */
    static async readPages(store: JournaledStore, name: string, pages: number): Promise<unknown[]> {
        const stored = await Promise.all(
            Array.from({ length: pages }, (_, page) =>
                store.readRecord<unknown[]>(`${name}/${page}`),
            ),
        );
        return stored.flatMap((page) => page ?? []);
    }

    /** Opens the index under `name` from its `pages` pages. */
    static async load(store: JournaledStore, name: string, pages: number): Promise<PagedIndex> {
        const entries = (await PagedIndex.readPages(store, name, pages)).filter(
            (entry): entry is IndexEntry => Array.isArray(entry),
        );
        return new PagedIndex(name, entries);
    }

    /** The entries in display order. */
    entries(): readonly IndexEntry[] {
        return this.list;
    }

    get size(): number {
        return this.list.length;
    }

    has(id: string): boolean {
        return this.positions.has(id);
    }

    entryOf(id: string): IndexEntry | undefined {
        const position = this.positions.get(id);
        return position === undefined ? undefined : this.list[position];
    }

    /** Pages the index takes. */
    pages(): number {
        return Math.ceil(this.list.length / INDEX_PAGE_SIZE);
    }

    /** Adds an entry at the end, giving the page to write. An id already listed changes nothing. */
    append(entry: IndexEntry): JournalEntry[] {
        if (this.positions.has(entry[0])) return [];
        this.positions.set(entry[0], this.list.length);
        this.list.push(entry);
        return this.pageEntries(Math.floor((this.list.length - 1) / INDEX_PAGE_SIZE));
    }

    /** Sets `flag` on the entry of `id`, giving its page to write when it changed. */
    setFlag(id: string, flag: number): JournalEntry[] {
        const position = this.positions.get(id);
        const entry = position === undefined ? undefined : this.list[position];
        if (position === undefined || !entry || entry[2] & flag) return [];
        entry[2] |= flag;
        const page = Math.floor(position / INDEX_PAGE_SIZE);
        return [this.page(page)];
    }

    /** The pages from `from` on, to write. */
    pageEntries(from = 0): JournalEntry[] {
        const written: JournalEntry[] = [];
        for (let page = from; page < this.pages(); page++) written.push(this.page(page));
        return written;
    }

    /** Empties the index, giving the clears of its pages. */
    clear(): JournalEntry[] {
        const cleared: JournalEntry[] = [];
        for (let page = 0; page < this.pages(); page++)
            cleared.push([`${this.name}/${page}`, null]);
        this.list.length = 0;
        this.positions.clear();
        return cleared;
    }

    private page(page: number): JournalEntry {
        return [
            `${this.name}/${page}`,
            encodeRecord(this.list.slice(page * INDEX_PAGE_SIZE, (page + 1) * INDEX_PAGE_SIZE)),
        ];
    }
}

/** Buckets of a {@link ClaimSet}. */
export const CLAIM_BUCKETS = 32;

function bucketOf(id: string): number {
    let hash = 0;
    for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    return hash % CLAIM_BUCKETS;
}

/**
 * Ids that had a one-time effect, under `<prefix>/<bucket>`. `claim` answers
 * `true` once per id, so an effect retried after a restart runs once.
 */
export class ClaimSet {
    private constructor(
        private readonly store: JournaledStore,
        private readonly prefix: string,
        private readonly buckets: Map<number, Set<string>>,
    ) {}

    /** Opens the claims under `prefix`, reading every bucket at once. */
    static async load(store: JournaledStore, prefix: string): Promise<ClaimSet> {
        const stored = await Promise.all(
            Array.from({ length: CLAIM_BUCKETS }, (_, bucket) =>
                store.readRecord<string[]>(`${prefix}/${bucket}`),
            ),
        );
        const buckets = new Map<number, Set<string>>();
        stored.forEach((ids, bucket) => {
            if (ids) buckets.set(bucket, new Set(ids));
        });
        return new ClaimSet(store, prefix, buckets);
    }

    has(id: string): boolean {
        return this.buckets.get(bucketOf(id))?.has(id) ?? false;
    }

    /** Claims `id`. `false` when it was claimed before. Durable when it resolves `true`. */
    async claim(id: string): Promise<boolean> {
        const bucket = bucketOf(id);
        const ids = this.buckets.get(bucket) ?? new Set<string>();
        if (ids.has(id)) return false;
        ids.add(id);
        this.buckets.set(bucket, ids);
        await this.store.commit([[`${this.prefix}/${bucket}`, encodeRecord([...ids])]]);
        return true;
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { openJournaledStore, decodeRecord } = await import("./journal.js");
    const { MemoryByteStore } = await import("./testing.js");

    describe("PagedIndex", () => {
        test("adding past a page boundary writes the new page only, and reopening reads it back", async () => {
            const kv = new MemoryByteStore();
            const store = await openJournaledStore(kv, "p");
            const index = new PagedIndex("mi/room");
            for (let order = 0; order < INDEX_PAGE_SIZE; order++)
                await store.commit(index.append([`m${order}`, order, 0]));
            const next = index.append(["m256", 256, 0]);
            expect(next.map(([name]) => name)).toEqual(["mi/room/1"]);
            await store.commit(next);
            const reopened = await PagedIndex.load(store, "mi/room", index.pages());
            expect(reopened.size).toBe(257);
            expect(reopened.entryOf("m256")).toEqual(["m256", 256, 0]);
        });

        test("a flag rewrites the entry's page once", async () => {
            const index = new PagedIndex("i", [["a", 1, 0]]);
            const written = index.setFlag("a", 2);
            expect(written).toHaveLength(1);
            expect(decodeRecord(written[0]?.[1] as Uint8Array)).toEqual([["a", 1, 2]]);
            expect(index.setFlag("a", 2)).toEqual([]);
        });
    });

    describe("ClaimSet", () => {
        test("an id is claimed once, across a reopen", async () => {
            const kv = new MemoryByteStore();
            const store = await openJournaledStore(kv, "p");
            const claims = await ClaimSet.load(store, "c");
            expect(await claims.claim("m1")).toBe(true);
            expect(await claims.claim("m1")).toBe(false);
            const reopened = await ClaimSet.load(await openJournaledStore(kv.snapshot(), "p"), "c");
            expect(reopened.has("m1")).toBe(true);
            expect(await reopened.claim("m1")).toBe(false);
        });

        test("buckets are hash * 31 + code, modulo 32, as the person chat keeps them", async () => {
            const kv = new MemoryByteStore();
            const claims = await ClaimSet.load(await openJournaledStore(kv, "p"), "p");
            await claims.claim("a");
            expect([...kv.data.keys()]).toEqual([`p/p/${"a".charCodeAt(0) % 32}`]);
        });
    });
}
