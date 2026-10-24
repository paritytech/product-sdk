// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A product-source room built from the toolkit alone, driven through the host
 * double the way a host screen drives it: opened, scrolled, written to, edited,
 * reacted to, seen, searched.
 */
import type {
    ChatMessageBody,
    ChatRoomMessage,
    ChatUserAction,
    ProductChatUserActionItem,
} from "@parity/product-sdk-host";
import { describe, expect, test } from "vitest";

import { userActions } from "./actions.js";
import {
    type ParticipantReaction,
    type Revision,
    bodyText,
    editHistory,
    latestRevision,
    message,
    reactionChanges,
    reactionDetails,
    reactionSummaries,
    text,
} from "./builders.js";
import { RoomDeclarations } from "./declarations.js";
import { FeedSender } from "./feed.js";
import { PARTICIPANT } from "./ids.js";
import { matchesText, numberCursor, orderedArray, page, searchPage } from "./paging.js";
import { PreviewScheduler, buildPreview } from "./previews.js";
import { type RoomSource, serveRoomsOn } from "./router.js";
import { type ChatTestbed, createChatTestbed, settle } from "./testing.js";

/** A room that keeps its messages in memory and answers every question from them. */
class MemoryRoom implements RoomSource {
    private readonly order: string[] = [];
    private readonly records = new Map<
        string,
        { body: ChatMessageBody; from: string; timestamp: bigint }
    >();
    private readonly reactionsOf = new Map<string, ParticipantReaction[]>();
    private readonly revisionsOf = new Map<string, Revision[]>();
    private seenUpTo: string | undefined;

    constructor(
        private readonly roomId: string,
        private readonly feed: FeedSender,
        private readonly previews: PreviewScheduler,
        private readonly now: () => bigint,
    ) {}

    /** The room as the host draws it. */
    view(messageId: string): ChatRoomMessage {
        const record = this.records.get(messageId);
        if (!record) throw new Error(`no message ${messageId}`);
        const edit = latestRevision(this.revisionsOf.get(messageId) ?? []);
        return message({
            messageId,
            from: record.from,
            timestamp: record.timestamp,
            body: edit ? text(edit.text ?? "") : record.body,
            ...(edit ? { editedAt: edit.editedAt } : {}),
            reactions: reactionSummaries(this.reactionsOf.get(messageId) ?? []),
        });
    }

    /** The product writes into the room, as a bot would. */
    post(messageId: string, body: ChatMessageBody, from: string = PARTICIPANT.product): void {
        this.store(messageId, body, from, this.now());
        this.feed.push(this.roomId, { tag: "New", value: this.view(messageId) });
        this.refreshPreview();
    }

    messages: RoomSource["messages"] = (anchor, pageSize) =>
        page(orderedArray(this.order.map((id) => this.view(id))), numberCursor, anchor, pageSize);

    userAction: (action: ChatUserAction) => Promise<ProductChatUserActionItem> = userActions({
        existing: async (messageId) =>
            this.records.has(messageId) ? this.view(messageId) : undefined,
        newMessage: async ({ body, messageId, timestamp }) => {
            const id = messageId ?? `own-${this.order.length}`;
            this.store(id, body, PARTICIPANT.user, timestamp ?? this.now());
            this.refreshPreview();
            return this.view(id);
        },
        editMessage: async ({ messageId, body }) => {
            const revisions = this.revisionsOf.get(messageId) ?? [];
            const edited = bodyText(body);
            revisions.push({
                editedAt: this.now(),
                ...(edited !== undefined ? { text: edited } : {}),
            });
            this.revisionsOf.set(messageId, revisions);
        },
        reactionPlaced: async ({ messageId, emoji }) => this.react(messageId, emoji, true),
        reactionRemoved: async ({ messageId, emoji }) => this.react(messageId, emoji, false),
        seen: async ({ messageId }) => {
            this.seenUpTo = messageId;
            this.refreshPreview();
        },
    });

    reactions = async (messageId: string) => reactionDetails(this.reactionsOf.get(messageId) ?? []);

    search: NonNullable<RoomSource["search"]> = async (needle, cursor, pageSize) =>
        searchPage(
            [...this.order]
                .reverse()
                .map((id) => this.view(id))
                .filter((entry) => matchesText(entry.body, needle)),
            cursor,
            pageSize,
        );

    editHistory = async (messageId: string) => {
        const record = this.records.get(messageId);
        const original = record ? bodyText(record.body) : undefined;
        return editHistory(
            {
                timestamp: record?.timestamp ?? 0n,
                ...(original !== undefined ? { text: original } : {}),
            },
            this.revisionsOf.get(messageId) ?? [],
        );
    };

    private store(messageId: string, body: ChatMessageBody, from: string, timestamp: bigint): void {
        this.order.push(messageId);
        this.records.set(messageId, { body, from, timestamp });
    }

    private react(messageId: string, emoji: string, placed: boolean): void {
        const before = this.reactionsOf.get(messageId) ?? [];
        const others = before.filter((reaction) => reaction.participantId !== PARTICIPANT.user);
        const after = placed
            ? [...others, { participantId: PARTICIPANT.user, emoji, timestamp: this.now() }]
            : others;
        this.reactionsOf.set(messageId, after);
        for (const update of reactionChanges(messageId, before, after))
            this.feed.push(this.roomId, update);
    }

    private refreshPreview(): void {
        void this.previews.schedule(this.roomId, async () => {
            const newestId = this.order[this.order.length - 1];
            const seen = this.seenUpTo ? this.order.indexOf(this.seenUpTo) : -1;
            const unread = this.order
                .slice(seen + 1)
                .filter((id) => this.records.get(id)?.from !== PARTICIPANT.user).length;
            return buildPreview({ ...(newestId ? { newest: this.view(newestId) } : {}), unread });
        });
    }
}

async function openSupportRoom(testbed: ChatTestbed) {
    const { host, client, rooms, clock } = testbed;
    const feed = new FeedSender(rooms, { clock });
    const previews = new PreviewScheduler(rooms, { clock });
    const room = new MemoryRoom("support", feed, previews, () => BigInt(clock.nowMs()));
    serveRoomsOn(client, { resolve: (roomId) => (roomId === "support" ? room : undefined) });
    const declared = await new RoomDeclarations(rooms).declare("support", {
        name: "Support",
        config: { productSource: true, reactionDetails: true, reportSeen: true },
        metadata: { name: "Support", description: "Ask us anything" },
    });
    expect(declared.ok).toBe(true);
    const flush = async () => {
        for (let round = 0; round < 5; round++) {
            await settle();
            await clock.advance(250);
        }
        await feed.flushed();
        await previews.flushed();
    };
    return { host, room, flush };
}

describe("a product-source room built from the toolkit", () => {
    test("opens on the newest page and scrolls back", async () => {
        const { host, room, flush } = await openSupportRoom(createChatTestbed());
        for (let index = 0; index < 25; index++) room.post(`m${index}`, text(`message ${index}`));
        await flush();
        const newest = await host.openRoom("support", 10);
        expect(newest.ok && newest.value.messages.map((entry) => entry.messageId)).toEqual(
            Array.from({ length: 10 }, (_, index) => `m${index + 15}`),
        );
        const older = newest.ok
            ? await host.page(
                  "support",
                  { tag: "Before", value: { cursor: newest.value.next } },
                  10,
              )
            : newest;
        expect(older.ok && older.value.messages[0]?.messageId).toBe("m5");
        expect(host.room("support").feed).toHaveLength(25);
    });

    test("a message the user sends keeps the host's id, and a repeat after a time-out sends nothing new", async () => {
        const { host, flush } = await openSupportRoom(createChatTestbed());
        const first = await host.userSends("support", text("hello"), { messageId: "host-1" });
        const again = await host.userSends("support", text("hello"), { messageId: "host-1" });
        expect(first).toEqual(again);
        expect(
            first.ok && first.value.tag === "MessageCreated" && first.value.value.messageId,
        ).toBe("host-1");
        await flush();
        const opened = await host.openRoom("support");
        expect(opened.ok && opened.value.messages.map((entry) => entry.messageId)).toEqual([
            "host-1",
        ]);
    });

    test("edits, reactions, who reacted and the edit history", async () => {
        const { host, room, flush } = await openSupportRoom(createChatTestbed());
        room.post("q", text("How do I pay?"));
        await host.userSends("support", text("with coins"), { messageId: "a" });
        await host.userAction("support", {
            tag: "EditMessage",
            value: { messageId: "a", body: text("with coins, from the wallet") },
        });
        await host.userAction("support", {
            tag: "ReactionPlaced",
            value: { messageId: "q", emoji: "👍" },
        });
        await flush();
        const history = await host.editHistory("support", "a");
        expect(history.ok && history.value.revisions.map((revision) => revision.text)).toEqual([
            "with coins",
            "with coins, from the wallet",
        ]);
        const who = await host.reactions("support", "q");
        expect(
            who.ok &&
                who.value.reactions.map((reaction) => [reaction.participantId, reaction.emoji]),
        ).toEqual([["user", "👍"]]);
        expect(host.room("support").feed.map((update) => update.tag)).toEqual([
            "New",
            "ReactionPlaced",
        ]);
    });

    test("search finds texts newest first, and seen clears the unread badge", async () => {
        const { host, room, flush } = await openSupportRoom(createChatTestbed());
        room.post("1", text("Coins arrive in a minute"));
        room.post("2", text("Nothing to see"));
        room.post("3", text("More coins"));
        await flush();
        expect(host.room("support").preview?.badge).toEqual({
            tag: "UnreadCount",
            value: { count: 3 },
        });
        const found = await host.search("support", "coins");
        expect(found.ok && found.value.hits.map((hit) => hit.messageId)).toEqual(["3", "1"]);
        await host.userAction("support", { tag: "Seen", value: { messageId: "3" } });
        await flush();
        expect(host.room("support").preview?.badge).toEqual({ tag: "Hidden" });
        expect(host.room("support").preview?.lastMessage?.messageId).toBe("3");
    });
});
