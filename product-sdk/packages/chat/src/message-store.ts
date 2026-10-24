// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The messages of a product's rooms, kept on the device.
 *
 * A product-source room's messages live in the product. A product whose messages
 * come from a backend may only cache them; one whose messages exist nowhere else
 * (a peer-to-peer chat) must keep them. {@link RoomMessageStore} is what the
 * stored room (`StoredRoom`) reads and writes: messages in display order per room,
 * each participant's reactions, the revisions of edited messages, a read marker
 * per room, and one-time claims per message.
 *
 * {@link MemoryRoomMessageStore} keeps it in memory; {@link JournaledRoomMessageStore}
 * keeps it in host storage, where every change spanning keys lands whole, opening
 * reads the indexes only, and records are read when first asked for.
 *
 * @module
 */
import type { ChatMessageBody, ChatMessageStatus } from "@parity/product-sdk-host";
import {
    ClaimSet,
    type JournalEntry,
    type JournaledStore,
    PagedIndex,
    encodeRecord,
} from "@parity/product-sdk-local-storage";

import type { ParticipantReaction, Revision } from "./builders.js";

/** A message as a room keeps it. */
export interface StoredMessage {
    messageId: string;
    roomId: string;
    /** The participant id of its author. */
    from: string;
    /** When it was written, in milliseconds since the Unix epoch. */
    timestamp: bigint;
    body: ChatMessageBody;
    status: ChatMessageStatus;
    replyTo?: string;
    /** The welcome message of a chat request. */
    request?: boolean;
    /** Display order, given when the message is first stored and kept after. */
    order: number;
}

/** A message to store; the store gives its order. */
export type NewStoredMessage = Omit<StoredMessage, "order">;

/** Which messages of a room to read, by order. Both bounds are excluded. */
export interface MessageRange {
    before?: number;
    after?: number;
    /** At most this many, the newest of the range. */
    limit?: number;
}

/** The messages of a product's rooms. Every write is durable when its promise resolves. */
export interface RoomMessageStore {
    get(messageId: string): Promise<StoredMessage | undefined>;
    /** Stores a message. A message already stored keeps its order. */
    put(message: NewStoredMessage): Promise<StoredMessage>;
    /** Messages of a room, newest first. */
    messages(roomId: string, range?: MessageRange): Promise<StoredMessage[]>;
    reactions(messageId: string): Promise<ParticipantReaction[]>;
    setReactions(messageId: string, reactions: ParticipantReaction[]): Promise<void>;
    /** Revisions of an edited message, in the order they were added. */
    revisions(messageId: string): Promise<Revision[]>;
    addRevision(messageId: string, revision: Revision): Promise<void>;
    /** The order of the newest message the user saw in a room. */
    seenOrder(roomId: string): Promise<number | undefined>;
    setSeenOrder(roomId: string, order: number): Promise<void>;
    /** Every room that holds a message. */
    roomIds(): Promise<string[]>;
    /** Deletes a room's messages, reactions, revisions and read marker. */
    deleteRoom(roomId: string): Promise<void>;
    /** Claims a one-time effect (`purpose`) of a message. `false` when claimed before. */
    claim(messageId: string, purpose: string): Promise<boolean>;
}

function inRange(order: number, range: MessageRange): boolean {
    return (
        order < (range.before ?? Number.POSITIVE_INFINITY) &&
        order > (range.after ?? Number.NEGATIVE_INFINITY)
    );
}

/** A {@link RoomMessageStore} in memory, for tests and as the cache under the journaled store. */
export class MemoryRoomMessageStore implements RoomMessageStore {
    private readonly records = new Map<string, StoredMessage>();
    private readonly reactionsOf = new Map<string, ParticipantReaction[]>();
    private readonly revisionsOf = new Map<string, Revision[]>();
    private readonly seen = new Map<string, number>();
    private readonly claims = new Set<string>();
    private counter = 0;

    async get(messageId: string) {
        return this.records.get(messageId);
    }

    async put(message: NewStoredMessage) {
        const existing = this.records.get(message.messageId);
        const order = existing?.order ?? ++this.counter;
        const stored: StoredMessage = { ...message, order };
        this.records.set(message.messageId, stored);
        return stored;
    }

    /** Stores a message with the order it already has, as the journaled store loads one. */
    remember(message: StoredMessage): void {
        this.records.set(message.messageId, message);
        this.counter = Math.max(this.counter, message.order);
    }

    async messages(roomId: string, range: MessageRange = {}) {
        const matching = [...this.records.values()]
            .filter((message) => message.roomId === roomId && inRange(message.order, range))
            .sort((left, right) => right.order - left.order);
        return range.limit === undefined ? matching : matching.slice(0, range.limit);
    }

    async reactions(messageId: string) {
        return this.reactionsOf.get(messageId) ?? [];
    }

    async setReactions(messageId: string, reactions: ParticipantReaction[]) {
        this.reactionsOf.set(messageId, reactions);
    }

    async revisions(messageId: string) {
        return this.revisionsOf.get(messageId) ?? [];
    }

    async addRevision(messageId: string, revision: Revision) {
        this.revisionsOf.set(messageId, [...(this.revisionsOf.get(messageId) ?? []), revision]);
    }

    async seenOrder(roomId: string) {
        return this.seen.get(roomId);
    }

    async setSeenOrder(roomId: string, order: number) {
        this.seen.set(roomId, order);
    }

    async roomIds() {
        return [...new Set([...this.records.values()].map((message) => message.roomId))];
    }

    async deleteRoom(roomId: string) {
        for (const [id, message] of this.records) {
            if (message.roomId !== roomId) continue;
            this.records.delete(id);
            this.reactionsOf.delete(id);
            this.revisionsOf.delete(id);
        }
        this.seen.delete(roomId);
    }

    async claim(messageId: string, purpose: string) {
        const key = `${purpose}\u0000${messageId}`;
        if (this.claims.has(key)) return false;
        this.claims.add(key);
        return true;
    }
}

/** Schema of the records a {@link JournaledRoomMessageStore} writes. */
export const ROOM_STORE_SCHEMA = 1;

const HAS_REACTIONS = 1;
const HAS_REVISIONS = 2;

interface Meta {
    schema: number;
    order: number;
    /** Index pages per room. */
    rooms: Record<string, number>;
    seen: Record<string, number>;
}

/**
 * A {@link RoomMessageStore} in host storage, under a journaled store's prefix.
 *
 * Layout: `meta`, each message at `m/<id>`, its reactions at `x/<id>` and its
 * revisions at `v/<id>`, each room's index at `i/<room>/<page>`, and the claims
 * of each purpose at `k/<purpose>/<bucket>`.
 */
export class JournaledRoomMessageStore implements RoomMessageStore {
    private readonly memory = new MemoryRoomMessageStore();
    private readonly indexes = new Map<string, PagedIndex>();
    private readonly roomOf = new Map<string, string>();
    /** Ids whose records are in memory, or turned out to have none. */
    private readonly loaded = new Set<string>();
    private readonly claimSets = new Map<string, Promise<ClaimSet>>();

    private constructor(
        private readonly store: JournaledStore,
        private meta: Meta,
    ) {}

    /** Opens the store, reading its metadata and every room's index, not the messages. */
    static async open(store: JournaledStore): Promise<JournaledRoomMessageStore> {
        const meta = (await store.readRecord<Meta>("meta")) ?? {
            schema: ROOM_STORE_SCHEMA,
            order: 0,
            rooms: {},
            seen: {},
        };
        if (meta.schema !== ROOM_STORE_SCHEMA)
            throw new Error(`unsupported room store schema ${meta.schema}`);
        const opened = new JournaledRoomMessageStore(store, meta);
        await Promise.all(
            Object.entries(meta.rooms).map(async ([roomId, pages]) => {
                const index = await PagedIndex.load(store, opened.indexName(roomId), pages);
                opened.indexes.set(roomId, index);
                for (const [id] of index.entries()) opened.roomOf.set(id, roomId);
            }),
        );
        return opened;
    }

    /** Resolves when every write so far is durable. */
    flush(): Promise<void> {
        return this.store.flush();
    }

    async get(messageId: string) {
        await this.ensureLoaded([messageId]);
        return this.memory.get(messageId);
    }

    async put(message: NewStoredMessage) {
        await this.ensureLoaded([message.messageId]);
        const existing = await this.memory.get(message.messageId);
        const order = existing?.order ?? ++this.meta.order;
        const stored: StoredMessage = { ...message, order };
        this.memory.remember(stored);
        this.loaded.add(stored.messageId);
        const entries: JournalEntry[] = [[`m/${stored.messageId}`, encodeRecord(stored)]];
        if (!existing) {
            const index = this.indexOf(stored.roomId);
            entries.push(...index.append([stored.messageId, order, 0]));
            this.roomOf.set(stored.messageId, stored.roomId);
            this.meta.rooms[stored.roomId] = index.pages();
            entries.push(this.metaEntry());
        }
        await this.store.commit(entries);
        return stored;
    }

    async messages(roomId: string, range: MessageRange = {}) {
        const matching = (this.indexes.get(roomId)?.entries() ?? []).filter(([, order]) =>
            inRange(order, range),
        );
        const wanted = range.limit === undefined ? matching : matching.slice(-range.limit);
        await this.ensureLoaded(wanted.map(([id]) => id));
        return this.memory.messages(roomId, range);
    }

    async reactions(messageId: string) {
        await this.ensureLoaded([messageId]);
        return this.memory.reactions(messageId);
    }

    async setReactions(messageId: string, reactions: ParticipantReaction[]) {
        await this.ensureLoaded([messageId]);
        await this.memory.setReactions(messageId, reactions);
        await this.store.commit([
            [`x/${messageId}`, encodeRecord(reactions)],
            ...this.flag(messageId, HAS_REACTIONS),
        ]);
    }

    async revisions(messageId: string) {
        await this.ensureLoaded([messageId]);
        return this.memory.revisions(messageId);
    }

    async addRevision(messageId: string, revision: Revision) {
        await this.ensureLoaded([messageId]);
        await this.memory.addRevision(messageId, revision);
        await this.store.commit([
            [`v/${messageId}`, encodeRecord(await this.memory.revisions(messageId))],
            ...this.flag(messageId, HAS_REVISIONS),
        ]);
    }

    async seenOrder(roomId: string) {
        return this.meta.seen[roomId];
    }

    async setSeenOrder(roomId: string, order: number) {
        this.meta.seen = { ...this.meta.seen, [roomId]: order };
        await this.store.commit([this.metaEntry()]);
    }

    async roomIds() {
        return Object.keys(this.meta.rooms);
    }

    async deleteRoom(roomId: string) {
        const index = this.indexes.get(roomId);
        await this.memory.deleteRoom(roomId);
        const entries: JournalEntry[] = [];
        for (const [id, , flags] of index?.entries() ?? []) {
            this.roomOf.delete(id);
            this.loaded.delete(id);
            entries.push([`m/${id}`, null]);
            if (flags & HAS_REACTIONS) entries.push([`x/${id}`, null]);
            if (flags & HAS_REVISIONS) entries.push([`v/${id}`, null]);
        }
        entries.push(...(index?.clear() ?? []));
        this.indexes.delete(roomId);
        const { [roomId]: _pages, ...rooms } = this.meta.rooms;
        const { [roomId]: _seen, ...seen } = this.meta.seen;
        this.meta = { ...this.meta, rooms, seen };
        entries.push(this.metaEntry());
        await this.store.commit(entries);
    }

    async claim(messageId: string, purpose: string) {
        let claims = this.claimSets.get(purpose);
        if (!claims) {
            claims = ClaimSet.load(this.store, `k/${encodeURIComponent(purpose)}`);
            this.claimSets.set(purpose, claims);
        }
        return (await claims).claim(messageId);
    }

    private indexName(roomId: string): string {
        return `i/${encodeURIComponent(roomId)}`;
    }

    private indexOf(roomId: string): PagedIndex {
        let index = this.indexes.get(roomId);
        if (!index) {
            index = new PagedIndex(this.indexName(roomId));
            this.indexes.set(roomId, index);
        }
        return index;
    }

    private metaEntry(): JournalEntry {
        return ["meta", encodeRecord(this.meta)];
    }

    private flag(messageId: string, flag: number): JournalEntry[] {
        const roomId = this.roomOf.get(messageId);
        return roomId ? (this.indexes.get(roomId)?.setFlag(messageId, flag) ?? []) : [];
    }

    /** Reads the records of `ids` not in memory yet, all at once. */
    private async ensureLoaded(ids: string[]): Promise<void> {
        const missing = ids.filter((id) => !this.loaded.has(id) && this.roomOf.has(id));
        await Promise.all(
            missing.map(async (id) => {
                const roomId = this.roomOf.get(id) as string;
                const flags = this.indexes.get(roomId)?.entryOf(id)?.[2] ?? 0;
                const [message, reactions, revisions] = await Promise.all([
                    this.store.readRecord<StoredMessage>(`m/${id}`),
                    flags & HAS_REACTIONS
                        ? this.store.readRecord<ParticipantReaction[]>(`x/${id}`)
                        : undefined,
                    flags & HAS_REVISIONS
                        ? this.store.readRecord<Revision[]>(`v/${id}`)
                        : undefined,
                ]);
                if (message) {
                    this.memory.remember(message);
                    if (reactions) await this.memory.setReactions(id, reactions);
                    for (const revision of revisions ?? [])
                        await this.memory.addRevision(id, revision);
                }
                this.loaded.add(id);
            }),
        );
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { openJournaledStore } = await import("@parity/product-sdk-local-storage");
    const { MemoryByteStore, WorkerStoppedError } = await import(
        "@parity/product-sdk-local-storage/testing"
    );

    const message = (messageId: string, roomId = "r"): NewStoredMessage => ({
        messageId,
        roomId,
        from: "product",
        timestamp: 1n,
        body: { tag: "Text", value: { text: messageId } },
        status: "Sent",
    });

    const stores: [string, () => Promise<RoomMessageStore>][] = [
        ["memory", async () => new MemoryRoomMessageStore()],
        [
            "journaled",
            async () =>
                JournaledRoomMessageStore.open(
                    await openJournaledStore(new MemoryByteStore(), "rooms"),
                ),
        ],
    ];

    describe.each(stores)("%s store", (_name, open) => {
        test("orders messages per room, newest first, and keeps an order on a re-put", async () => {
            const store = await open();
            await store.put(message("a"));
            await store.put(message("x", "other"));
            await store.put(message("b"));
            await store.put({ ...message("a"), status: "Read" });
            const listed = await store.messages("r");
            expect(listed.map((entry) => [entry.messageId, entry.status])).toEqual([
                ["b", "Sent"],
                ["a", "Read"],
            ]);
            expect(
                (await store.messages("r", { limit: 1 })).map((entry) => entry.messageId),
            ).toEqual(["b"]);
            expect(
                (await store.messages("r", { before: (await store.get("b"))?.order })).map(
                    (entry) => entry.messageId,
                ),
            ).toEqual(["a"]);
        });

        test("reactions, revisions, read marker, claims and deleting a room", async () => {
            const store = await open();
            await store.put(message("a"));
            await store.setReactions("a", [{ participantId: "user", emoji: "👍", timestamp: 2n }]);
            await store.addRevision("a", { editedAt: 3n, text: "edited" });
            await store.setSeenOrder("r", 1);
            expect(await store.claim("a", "push")).toBe(true);
            expect(await store.claim("a", "push")).toBe(false);
            expect(await store.claim("a", "processed")).toBe(true);
            expect(await store.reactions("a")).toHaveLength(1);
            expect(await store.revisions("a")).toEqual([{ editedAt: 3n, text: "edited" }]);
            await store.deleteRoom("r");
            expect(await store.get("a")).toBeUndefined();
            expect(await store.seenOrder("r")).toBeUndefined();
            expect(await store.roomIds()).toEqual([]);
        });
    });

    describe("JournaledRoomMessageStore", () => {
        test("reopening reads indexes only, and a record when it is asked for", async () => {
            const kv = new MemoryByteStore();
            const store = await JournaledRoomMessageStore.open(
                await openJournaledStore(kv, "rooms"),
            );
            for (let index = 0; index < 300; index++) await store.put(message(`m${index}`));
            await store.setReactions("m5", [
                { participantId: "contact", emoji: "🎉", timestamp: 9n },
            ]);
            const reopenedKv = kv.snapshot();
            const reopened = await JournaledRoomMessageStore.open(
                await openJournaledStore(reopenedKv, "rooms"),
            );
            const readsAfterOpen = reopenedKv.reads;
            expect(readsAfterOpen).toBeLessThan(10);
            expect(
                (await reopened.messages("r", { limit: 2 })).map((entry) => entry.messageId),
            ).toEqual(["m299", "m298"]);
            expect(reopenedKv.reads - readsAfterOpen).toBe(2);
            expect(await reopened.reactions("m5")).toEqual([
                { participantId: "contact", emoji: "🎉", timestamp: 9n },
            ]);
            await reopened.put(message("new"));
            expect((await reopened.get("new"))?.order).toBe(301);
        });

        test("a room of 10,000 messages opens from its 40 index pages and pages 50 messages with 50 reads", async () => {
            const kv = new MemoryByteStore();
            const store = await JournaledRoomMessageStore.open(
                await openJournaledStore(kv, "rooms"),
            );
            for (let index = 0; index < 10_000; index++) await store.put(message(`m${index}`));
            const reopenedKv = kv.snapshot();
            const reopened = await JournaledRoomMessageStore.open(
                await openJournaledStore(reopenedKv, "rooms"),
            );
            // The journal, the metadata and the 40 index pages.
            expect(reopenedKv.reads).toBe(42);
            const page = await reopened.messages("r", { limit: 50 });
            expect(page[0]?.messageId).toBe("m9999");
            expect(reopenedKv.reads).toBe(92);
        });

        test("a stop between a message and its index lands whole on the next open", async () => {
            const kv = new MemoryByteStore();
            const store = await JournaledRoomMessageStore.open(
                await openJournaledStore(kv, "rooms"),
            );
            await store.put(message("a"));
            kv.budget = kv.writes + 2;
            await expect(store.put(message("b"))).rejects.toThrow(WorkerStoppedError);
            const reopened = await JournaledRoomMessageStore.open(
                await openJournaledStore(kv.snapshot(), "rooms"),
            );
            expect((await reopened.messages("r")).map((entry) => entry.messageId)).toEqual([
                "b",
                "a",
            ]);
        });
    });
}
