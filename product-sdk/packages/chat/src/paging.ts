// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Answering the host's pages and searches of a product-source room.
 *
 * A room screen opens with `messages_query { Before: None }` (the newest page),
 * asks `Before` with the returned cursor as the user scrolls up, and `After`
 * when a jump to a message needs newer pages. Each page holds at most the asked
 * size, oldest first, with the cursor of the next page in the same direction;
 * no cursor ends that direction. Searches answer newest first.
 *
 * Cursors are opaque strings of at most 1 KiB, so any ordered source works: a
 * sort order, a timestamp with an id, a backend's own cursor.
 *
 * @module
 */
import type {
    ChatMessageBody,
    ChatPageAnchor,
    ChatRoomMessage,
    ProductChatMessagesQueryItem,
} from "@parity/product-sdk-host";

import { bodyText } from "./builders.js";
import { clampPageSize, clampSearchPageSize } from "./limits.js";

/** One message of an ordered source and where it is. */
export interface OrderedEntry<Cursor> {
    cursor: Cursor;
    message: ChatRoomMessage;
}

/** The messages of a room in display order, read a window at a time. */
export interface OrderedMessages<Cursor> {
    /** Up to `limit` messages before `before` (excluded), newest first; the newest when `before` is undefined. */
    newestFirst(before: Cursor | undefined, limit: number): Promise<OrderedEntry<Cursor>[]>;
    /** Up to `limit` messages after `after` (excluded), oldest first; the oldest when `after` is undefined. */
    oldestFirst(after: Cursor | undefined, limit: number): Promise<OrderedEntry<Cursor>[]>;
}

/** Turns a source's cursors into the strings the host carries, and back. */
export interface CursorCodec<Cursor> {
    encode(cursor: Cursor): string;
    /** The cursor of a string the product gave out. Throws on anything else. */
    decode(value: string): Cursor;
}

/** Cursors that are numbers, such as a sort order. */
export const numberCursor: CursorCodec<number> = {
    encode: (cursor) => String(cursor),
    decode: (value) => {
        const cursor = Number(value);
        if (!Number.isFinite(cursor)) throw new Error(`not a cursor: ${value.slice(0, 32)}`);
        return cursor;
    },
};

/** Cursors that are already strings. */
export const stringCursor: CursorCodec<string> = {
    encode: (cursor) => cursor,
    decode: (value) => value,
};

/**
 * One page for `messages_query`, oldest first, with the cursor of the next page in
 * the same direction.
 *
 * @example
 * ```ts
 * async messages(anchor, pageSize) {
 *     return page(store.ordered(roomId), numberCursor, anchor, pageSize);
 * }
 * ```
 */
export async function page<Cursor>(
    source: OrderedMessages<Cursor>,
    cursors: CursorCodec<Cursor>,
    anchor: ChatPageAnchor,
    pageSize: number,
): Promise<ProductChatMessagesQueryItem> {
    const size = clampPageSize(pageSize);
    const from =
        anchor.value.cursor === undefined ? undefined : cursors.decode(anchor.value.cursor);
    const window =
        anchor.tag === "Before"
            ? await source.newestFirst(from, size + 1)
            : await source.oldestFirst(from, size + 1);
    const entries = window.slice(0, size);
    const last = entries[entries.length - 1];
    const next = window.length > size && last ? cursors.encode(last.cursor) : undefined;
    if (anchor.tag === "Before") entries.reverse();
    return {
        messages: entries.map((entry) => entry.message),
        ...(next !== undefined ? { next } : {}),
    };
}

/**
 * Whether a body's text or caption contains `needle`, ignoring case, as the native
 * chat-list search matches.
 */
export function matchesText(body: ChatMessageBody, needle: string): boolean {
    return bodyText(body)?.toLowerCase().includes(needle.toLowerCase()) ?? false;
}

/**
 * One page for `search_query` from every match, newest first. The cursor is the
 * offset of the next page. Matches of any type page the same way, so a product can
 * page its own records and turn only the page into messages.
 */
export function searchPage<Match = ChatRoomMessage>(
    matchesNewestFirst: Match[],
    cursor: string | undefined,
    pageSize: number,
): { hits: Match[]; next?: string } {
    const size = clampSearchPageSize(pageSize);
    const offset = cursor === undefined ? 0 : numberCursor.decode(cursor);
    const hits = matchesNewestFirst.slice(offset, offset + size);
    return {
        hits,
        ...(offset + size < matchesNewestFirst.length ? { next: String(offset + size) } : {}),
    };
}

/** An {@link OrderedMessages} over an array in display order (oldest first), for tests and small rooms. */
export function orderedArray(messages: ChatRoomMessage[]): OrderedMessages<number> {
    return {
        async newestFirst(before, limit) {
            const end = before === undefined ? messages.length : Math.max(0, before);
            const start = Math.max(0, end - limit);
            return messages
                .slice(start, end)
                .map((message, index) => ({ cursor: start + index, message }))
                .reverse();
        },
        async oldestFirst(after, limit) {
            const start = after === undefined ? 0 : after + 1;
            return messages
                .slice(start, start + limit)
                .map((message, index) => ({ cursor: start + index, message }));
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { message, text } = await import("./builders.js");

    const messages = Array.from({ length: 7 }, (_, index) =>
        message({
            messageId: `m${index}`,
            from: "product",
            timestamp: BigInt(index),
            body: text(`message ${index}`),
        }),
    );
    const ids = (item: ProductChatMessagesQueryItem) =>
        item.messages.map((entry) => entry.messageId);

    describe("page", () => {
        const source = orderedArray(messages);

        test("Before with no cursor is the newest page, oldest first, with a cursor to older ones", async () => {
            const newest = await page(source, numberCursor, { tag: "Before", value: {} }, 3);
            expect(ids(newest)).toEqual(["m4", "m5", "m6"]);
            const older = await page(
                source,
                numberCursor,
                { tag: "Before", value: { cursor: newest.next } },
                3,
            );
            expect(ids(older)).toEqual(["m1", "m2", "m3"]);
            const oldest = await page(
                source,
                numberCursor,
                { tag: "Before", value: { cursor: older.next } },
                3,
            );
            expect(ids(oldest)).toEqual(["m0"]);
            expect(oldest.next).toBeUndefined();
        });

        test("After walks newer pages until the end", async () => {
            const first = await page(source, numberCursor, { tag: "After", value: {} }, 4);
            expect(ids(first)).toEqual(["m0", "m1", "m2", "m3"]);
            const rest = await page(
                source,
                numberCursor,
                { tag: "After", value: { cursor: first.next } },
                4,
            );
            expect(ids(rest)).toEqual(["m4", "m5", "m6"]);
            expect(rest.next).toBeUndefined();
        });

        test("a page size over the bound is clamped", async () => {
            const all = await page(source, numberCursor, { tag: "Before", value: {} }, 1000);
            expect(all.messages).toHaveLength(7);
        });
    });

    test("searchPage pages the matches newest first", () => {
        const matches = [...messages]
            .reverse()
            .filter((entry) => matchesText(entry.body, "MESSAGE"));
        const first = searchPage(matches, undefined, 5);
        expect(first.hits.map((hit) => hit.messageId)).toEqual(["m6", "m5", "m4", "m3", "m2"]);
        expect(searchPage(matches, first.next, 5).hits.map((hit) => hit.messageId)).toEqual([
            "m1",
            "m0",
        ]);
    });
}
