// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A product-source room served from a {@link RoomMessageStore}.
 *
 * `StoredRoom` answers every host question about one room (pages, user actions,
 * who reacted, search, edit history) from the store, and keeps the host in step
 * on every write: the matching feed update goes out, and the chat-list preview is
 * scheduled. A product decides only what to write (`post`, `edit`, `react`,
 * `setStatus`) and, through `onUserMessage`, what to do with what the user sends.
 *
 * @module
 */
import {
    type ChatMessageBody,
    type ChatMessageStatus,
    type ChatPageAnchor,
    type ChatReactionDetail,
    type ChatRoomMessage,
    type ChatUserAction,
    type HostError,
    type NotificationManager,
    type ProductChatMessagesQueryItem,
    type ProductChatSearchQueryItem,
    type ProductChatUserActionItem,
    type Result,
    UnknownMessageError,
    UserActionRejectedError,
    deriveEntropy,
    ok,
} from "@parity/product-sdk-host";
import { type Clock, type IdSource, systemClock, uuidSource } from "@parity/product-sdk-utils";

import { userActions } from "./actions.js";
import {
    type ParticipantReaction,
    bodyText,
    editHistory,
    latestRevision,
    message,
    reactionChanges,
    reactionDetails,
    reactionSummaries,
    replyPreview,
} from "./builders.js";
import type { FeedSender } from "./feed.js";
import { PARTICIPANT } from "./ids.js";
import type { NewStoredMessage, RoomMessageStore, StoredMessage } from "./message-store.js";
import { type OrderedMessages, matchesText, numberCursor, page, searchPage } from "./paging.js";
import { type PreviewScheduler, buildPreview } from "./previews.js";
import type { RoomSource } from "./router.js";

/** Options of a {@link StoredRoom}. */
export interface StoredRoomOptions {
    roomId: string;
    store: RoomMessageStore;
    feed: FeedSender;
    /** Keeps the room's place in the chat list. Without it no preview is sent. */
    previews?: PreviewScheduler;
    clock?: Clock;
    /** Ids of messages the user sends when the host chose none. Default random UUIDs. */
    ids?: IdSource;
    /**
     * Called with each message the user sends, after it is stored: deliver it to
     * the product's backend or peers. A throw rejects the send, and the host
     * removes the message and shows the reason (use `UserActionRejectedError` for
     * a reason the user should read).
     */
    onUserMessage?(message: StoredMessage): Promise<void>;
    /** Whether the user may edit their own text messages. Default `true`. */
    userEdits?: boolean;
    /** Whether the user may react. Default `true`. */
    userReactions?: boolean;
    /** Sends the room's notifications, for `post(…, { notify })`. */
    notifications?: Pick<NotificationManager, "pushRoom">;
}

/** What {@link StoredRoom.post} writes. */
export interface PostInput {
    messageId: string;
    body: ChatMessageBody;
    /** The author. Default `"product"`. */
    from?: string;
    /** Default now. */
    timestamp?: bigint;
    /** Default `"Sent"`. */
    status?: ChatMessageStatus;
    replyTo?: string;
    request?: boolean;
}

const SEARCH_WINDOW = 1_000;
const PREVIEW_WINDOW = 200;

/**
 * One product-source room over a message store.
 *
 * @example
 * ```ts
 * const room = new StoredRoom({ roomId: "support", store, feed, previews, onUserMessage: (m) => backend.send(m) });
 * serveRooms({ resolve: (roomId) => (roomId === "support" ? room : undefined) });
 * await room.post({ messageId: "welcome", body: text("How can we help?") });
 * ```
 */
export class StoredRoom implements RoomSource {
    readonly roomId: string;
    private readonly store: RoomMessageStore;
    private readonly feed: FeedSender;
    private readonly clock: Clock;
    readonly userAction: (action: ChatUserAction) => Promise<ProductChatUserActionItem>;

    constructor(private readonly options: StoredRoomOptions) {
        this.roomId = options.roomId;
        this.store = options.store;
        this.feed = options.feed;
        this.clock = options.clock ?? systemClock;
        this.userAction = userActions({
            existing: async (messageId) => {
                const known = await this.store.get(messageId);
                return known?.roomId === this.roomId ? this.view(known) : undefined;
            },
            newMessage: async ({ body, replyTo, messageId, timestamp }) => {
                const stored = await this.store.put({
                    messageId: messageId ?? (options.ids ?? uuidSource).next(),
                    roomId: this.roomId,
                    from: PARTICIPANT.user,
                    timestamp: timestamp ?? this.now(),
                    body,
                    status: "Sent",
                    ...(replyTo !== undefined ? { replyTo } : {}),
                });
                await this.options.onUserMessage?.(stored);
                this.refreshPreview();
                return this.view(stored);
            },
            ...(options.userEdits === false
                ? {}
                : {
                      editMessage: async ({
                          messageId,
                          body,
                      }: { messageId: string; body: ChatMessageBody }) => {
                          const target = await this.own(messageId);
                          if (target.from !== PARTICIPANT.user)
                              throw new UserActionRejectedError(
                                  "Only your own messages can be edited",
                              );
                          await this.addRevision(target, body);
                      },
                  }),
            ...(options.userReactions === false
                ? {}
                : {
                      reactionPlaced: ({
                          messageId,
                          emoji,
                      }: { messageId: string; emoji: string }) =>
                          this.react(messageId, PARTICIPANT.user, emoji, true),
                      reactionRemoved: ({
                          messageId,
                          emoji,
                      }: { messageId: string; emoji: string }) =>
                          this.react(messageId, PARTICIPANT.user, emoji, false),
                  }),
            seen: async ({ messageId }) => {
                const seen = await this.own(messageId);
                const previous = await this.store.seenOrder(this.roomId);
                if (previous === undefined || seen.order > previous) {
                    await this.store.setSeenOrder(this.roomId, seen.order);
                    this.refreshPreview();
                }
            },
        });
    }

    /**
     * Writes a message into the room (from the product, or a participant the product
     * names). With `notify` the user is told with the room's notification: `true`
     * sends the message's text, a string sends that. The host titles it with the
     * room's name and does not show it while the room is on screen, so a product
     * notifies for every message the user must know about.
     */
    async post(
        input: PostInput,
        options: { notify?: true | string } = {},
    ): Promise<ChatRoomMessage> {
        const stored = await this.store.put({
            messageId: input.messageId,
            roomId: this.roomId,
            from: input.from ?? PARTICIPANT.product,
            timestamp: input.timestamp ?? this.now(),
            body: input.body,
            status: input.status ?? "Sent",
            ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
            ...(input.request !== undefined ? { request: input.request } : {}),
        } satisfies NewStoredMessage);
        const view = await this.view(stored);
        this.feed.push(this.roomId, { tag: "New", value: view });
        this.refreshPreview();
        const notice = options.notify === true ? bodyText(input.body) : options.notify;
        if (notice && this.options.notifications)
            await this.options.notifications.pushRoom(this.roomId, notice);
        return view;
    }

    /** Replaces a message's text and marks it edited. */
    async edit(messageId: string, body: ChatMessageBody): Promise<void> {
        await this.addRevision(await this.own(messageId), body);
    }

    /** Places or removes one participant's reaction. */
    async react(
        messageId: string,
        participantId: string,
        emoji: string,
        placed: boolean,
    ): Promise<void> {
        await this.own(messageId);
        const before = await this.store.reactions(messageId);
        const rest = before.filter(
            (reaction) => reaction.participantId !== participantId || reaction.emoji !== emoji,
        );
        const after: ParticipantReaction[] = placed
            ? [...rest, { participantId, emoji, timestamp: this.now() }]
            : rest;
        await this.store.setReactions(messageId, after);
        for (const update of reactionChanges(messageId, before, after))
            this.feed.push(this.roomId, update);
    }

    /** Changes where a message is on its way (`Preparing`, `Sent`, `Delivered`, `Read`, `Failed`). */
    async setStatus(messageId: string, status: ChatMessageStatus): Promise<void> {
        const target = await this.own(messageId);
        if (target.status === status) return;
        await this.store.put({ ...target, status });
        this.feed.push(this.roomId, { tag: "StatusChanged", value: { messageId, status } });
        this.refreshPreview();
    }

    /** A stored message as the host draws it: the latest edit, the reactions, the reply quote. */
    async view(stored: StoredMessage): Promise<ChatRoomMessage> {
        const revisions = await this.store.revisions(stored.messageId);
        const edit = latestRevision(revisions);
        const quoted = stored.replyTo ? await this.store.get(stored.replyTo) : undefined;
        const body = edit ? editedBody(stored.body, edit.text) : stored.body;
        return message({
            messageId: stored.messageId,
            from: stored.from,
            timestamp: stored.timestamp,
            body,
            status: stored.status,
            ...(stored.replyTo !== undefined ? { replyTo: stored.replyTo } : {}),
            ...(quoted && quoted.roomId === this.roomId
                ? { replyPreview: replyPreview(await this.view(quoted)) }
                : {}),
            ...(edit ? { editedAt: edit.editedAt } : {}),
            reactions: reactionSummaries(await this.store.reactions(stored.messageId)),
            ...(stored.request ? { request: true } : {}),
        });
    }

    messages(anchor: ChatPageAnchor, pageSize: number): Promise<ProductChatMessagesQueryItem> {
        return page(this.ordered(), numberCursor, anchor, pageSize);
    }

    async reactions(messageId: string): Promise<ChatReactionDetail[]> {
        await this.own(messageId);
        return reactionDetails(await this.store.reactions(messageId));
    }

    async search(
        text: string,
        cursor: string | undefined,
        pageSize: number,
    ): Promise<ProductChatSearchQueryItem> {
        const matches: StoredMessage[] = [];
        for (const stored of await this.store.messages(this.roomId, { limit: SEARCH_WINDOW })) {
            const edit = latestRevision(await this.store.revisions(stored.messageId));
            const body = edit ? editedBody(stored.body, edit.text) : stored.body;
            if (matchesText(body, text)) matches.push(stored);
        }
        const found = searchPage(matches, cursor, pageSize);
        return {
            hits: await Promise.all(found.hits.map((hit) => this.view(hit))),
            ...(found.next !== undefined ? { next: found.next } : {}),
        };
    }

    async editHistory(messageId: string) {
        const stored = await this.own(messageId);
        const original = bodyText(stored.body);
        return editHistory(
            { timestamp: stored.timestamp, ...(original !== undefined ? { text: original } : {}) },
            await this.store.revisions(messageId),
        );
    }

    /** Messages of other participants after the user's read marker. */
    async unread(): Promise<number> {
        const seen = await this.store.seenOrder(this.roomId);
        return (
            await this.store.messages(this.roomId, {
                ...(seen !== undefined ? { after: seen } : {}),
                limit: PREVIEW_WINDOW,
            })
        ).filter((stored) => stored.from !== PARTICIPANT.user).length;
    }

    private ordered(): OrderedMessages<number> {
        const entries = (stored: StoredMessage[]) =>
            Promise.all(
                stored.map(async (entry) => ({
                    cursor: entry.order,
                    message: await this.view(entry),
                })),
            );
        return {
            newestFirst: async (before, limit) =>
                entries(
                    await this.store.messages(this.roomId, {
                        ...(before !== undefined ? { before } : {}),
                        limit,
                    }),
                ),
            oldestFirst: async (after, limit) => {
                // The store reads newest first; an older window is read whole, then the oldest kept.
                const newer = await this.store.messages(
                    this.roomId,
                    after !== undefined ? { after } : {},
                );
                return entries(newer.reverse().slice(0, limit));
            },
        };
    }

    private async own(messageId: string): Promise<StoredMessage> {
        const stored = await this.store.get(messageId);
        if (!stored || stored.roomId !== this.roomId) throw new UnknownMessageError(messageId);
        return stored;
    }

    private async addRevision(target: StoredMessage, body: ChatMessageBody): Promise<void> {
        const text = bodyText(body);
        const editedAt = this.now();
        await this.store.addRevision(target.messageId, {
            editedAt,
            ...(text !== undefined ? { text } : {}),
        });
        this.feed.push(this.roomId, {
            tag: "Edited",
            value: { messageId: target.messageId, body: editedBody(target.body, text), editedAt },
        });
        this.refreshPreview();
    }

    private refreshPreview(): void {
        const previews = this.options.previews;
        if (!previews) return;
        void previews.schedule(this.roomId, async () => {
            const [newest] = await this.store.messages(this.roomId, { limit: 1 });
            return buildPreview({
                ...(newest ? { newest: await this.view(newest) } : {}),
                unread: await this.unread(),
            });
        });
    }

    private now(): bigint {
        return BigInt(this.clock.nowMs());
    }
}

/** A body with its text replaced by an edit; media stay. */
function editedBody(body: ChatMessageBody, text: string | undefined): ChatMessageBody {
    if (body.tag === "RichText")
        return {
            tag: "RichText",
            value: { ...(text !== undefined ? { text } : {}), media: body.value.media },
        };
    return { tag: "Text", value: { text: text ?? "" } };
}

/**
 * The storage prefix of the signed-in identity: 8 bytes of host entropy derived
 * from `context`, in hex. Data kept under it is never read for another identity,
 * after a sign-out or an account switch.
 *
 * @example
 * ```ts
 * const scope = await sessionScope("my-chat/data/v1");
 * if (scope.ok) store = await openJournaledStore(kv, `my-chat/${scope.value}`);
 * ```
 */
export async function sessionScope(context: string): Promise<Result<string, HostError>> {
    const derived = await deriveEntropy(new TextEncoder().encode(context));
    if (!derived.ok) return derived;
    return ok(
        Array.from(derived.value.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
        ),
    );
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { createChatTestbed, settle } = await import("./testing.js");
    const { FeedSender } = await import("./feed.js");
    const { PreviewScheduler } = await import("./previews.js");
    const { MemoryRoomMessageStore } = await import("./message-store.js");
    const { serveRoomsOn } = await import("./router.js");
    const { RoomDeclarations } = await import("./declarations.js");
    const { text } = await import("./builders.js");

    async function setup(options: Partial<StoredRoomOptions> = {}) {
        const testbed = createChatTestbed();
        const { host, client, rooms, clock } = testbed;
        const feed = new FeedSender(rooms, { clock });
        const previews = new PreviewScheduler(rooms, { clock });
        const sent: StoredMessage[] = [];
        const room = new StoredRoom({
            roomId: "bot",
            store: new MemoryRoomMessageStore(),
            feed,
            previews,
            clock,
            onUserMessage: async (stored) => void sent.push(stored),
            ...options,
        });
        serveRoomsOn(client, { resolve: (roomId) => (roomId === "bot" ? room : undefined) });
        await new RoomDeclarations(rooms).declare("bot", {
            name: "Bot",
            config: { productSource: true, reactionDetails: true, reportSeen: true },
        });
        const flush = async () => {
            for (let round = 0; round < 5; round++) {
                await settle();
                await clock.advance(250);
            }
            await feed.flushed();
            await previews.flushed();
        };
        return { host, room, sent, flush };
    }

    describe("StoredRoom", () => {
        test("posts reach the feed and the preview; the host pages them back", async () => {
            const { host, room, flush } = await setup();
            await room.post({ messageId: "w", body: text("Welcome") });
            await room.post({ messageId: "q", body: text("Ask away") });
            await flush();
            expect(host.room("bot").feed.map((update) => update.tag)).toEqual(["New", "New"]);
            expect(host.room("bot").preview?.badge).toEqual({
                tag: "UnreadCount",
                value: { count: 2 },
            });
            const opened = await host.openRoom("bot");
            expect(opened.ok && opened.value.messages.map((entry) => entry.messageId)).toEqual([
                "w",
                "q",
            ]);
        });

        test("what the user sends is stored under the host's id and handed to the product once", async () => {
            const { host, sent } = await setup();
            await host.userSends("bot", text("hi"), { messageId: "u1" });
            await host.userSends("bot", text("hi"), { messageId: "u1" });
            expect(sent.map((entry) => entry.messageId)).toEqual(["u1"]);
            const opened = await host.openRoom("bot");
            expect(opened.ok && opened.value.messages[0]?.origin.participantId).toBe("user");
        });

        test("a rejected send is the user's to read", async () => {
            const { host } = await setup({
                onUserMessage: async () => {
                    throw new UserActionRejectedError("The bot is asleep");
                },
            });
            const outcome = await host.userSends("bot", text("hi"));
            expect(outcome.ok).toBe(false);
        });

        test("edits, reactions, search and history", async () => {
            const { host, room, flush } = await setup();
            await host.userSends("bot", text("first try"), { messageId: "u" });
            await host.userAction("bot", {
                tag: "EditMessage",
                value: { messageId: "u", body: text("second try") },
            });
            await room.react("u", "product", "👀", true);
            await flush();
            const found = await host.search("bot", "second");
            expect(found.ok && found.value.hits.map((hit) => hit.messageId)).toEqual(["u"]);
            const history = await host.editHistory("bot", "u");
            expect(history.ok && history.value.revisions.map((revision) => revision.text)).toEqual([
                "first try",
                "second try",
            ]);
            const who = await host.reactions("bot", "u");
            expect(who.ok && who.value.reactions.map((reaction) => reaction.participantId)).toEqual(
                ["product"],
            );
            expect(host.room("bot").feed.map((update) => update.tag)).toEqual([
                "Edited",
                "ReactionPlaced",
            ]);
        });

        test("a post can notify with its text", async () => {
            const pushed: [string, string][] = [];
            const { room } = await setup({
                notifications: {
                    pushRoom: async (roomId, text) => {
                        pushed.push([roomId, text]);
                        return pushed.length;
                    },
                },
            });
            await room.post({ messageId: "n", body: text("Your order shipped") }, { notify: true });
            await room.post(
                { messageId: "m", body: text("details") },
                { notify: "Shipping update" },
            );
            await room.post({ messageId: "o", body: text("quiet") });
            expect(pushed).toEqual([
                ["bot", "Your order shipped"],
                ["bot", "Shipping update"],
            ]);
        });

        test("seen moves the read marker and clears the badge", async () => {
            const { host, room, flush } = await setup();
            await room.post({ messageId: "a", body: text("one") });
            await room.post({ messageId: "b", body: text("two") });
            await flush();
            await host.userAction("bot", { tag: "Seen", value: { messageId: "b" } });
            await flush();
            expect(host.room("bot").preview?.badge).toEqual({ tag: "Hidden" });
            expect(await room.unread()).toBe(0);
        });

        test("an action on a message of another room is UnknownMessage", async () => {
            const { host } = await setup();
            const outcome = await host.userAction("bot", {
                tag: "ReactionPlaced",
                value: { messageId: "nope", emoji: "👍" },
            });
            expect(outcome).toEqual({
                ok: false,
                reason: { tag: "Domain", value: { tag: "V1", value: { tag: "UnknownMessage" } } },
            });
        });
    });
}
