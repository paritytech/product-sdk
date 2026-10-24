// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Chat Extension v2 rooms of a product, backed by `truApi.chat.*`.
 *
 * A product's worker owns the data of its rooms and the host draws them.
 * `getChatRooms()` returns the calls by which the product creates its rooms,
 * declares what each one serves, pushes changes to their messages and follows
 * what the user does with their calls. The host's questions (pages, user
 * actions, reactions, search, edit history, opened links) are answered through
 * `serveChatQueries` in `chat-queries.ts`.
 *
 * Every call returns a {@link Result}: a host refusal such as `RateLimited` or
 * `NotOwner` is an outcome a product handles, and arrives as a
 * {@link ChatRoomError}; a feature the host does not serve arrives as a
 * {@link FeatureUnavailableError}, without a call when the host's client lacks
 * the method.
 *
 * @module
 */
import type {
    ChatFeedUpdate,
    ChatMessageContent,
    ChatRoomCall,
    ChatRoomConfig,
    ChatRoomContact,
    ChatRoomFeatures,
    ChatRoomFooter,
    ChatRoomMetadata,
    ChatRoomPreview,
    ChatRoomRegistrationStatus,
    HostChatCreateRoomRequest,
    HostChatRoomEventsSubscribeItem,
    TrUApiClient,
} from "@parity/truapi";

/** The Chat Extension v2 vocabulary, re-exported from `@parity/truapi` so products and SDK packages name it from here. */
export type {
    ChatCallClose,
    ChatCallRecord,
    ChatContactEvent,
    ChatContactState,
    ChatFeedUpdate,
    ChatMediaItem,
    ChatMediaMeta,
    ChatMessage as ChatRoomMessage,
    ChatMessageBody,
    ChatMessageOrigin,
    ChatMessageRevision,
    ChatMessageStatus,
    ChatPageAnchor,
    ChatPaymentRecord,
    ChatPreviewReaction,
    ChatReactionDetail,
    ChatReactionSummary,
    ChatReplyPreview,
    ChatResource,
    ChatRoomBadge,
    ChatRoomCall,
    ChatRoomCalls,
    ChatRoomConfig,
    ChatRoomContact,
    ChatRoomEvent,
    ChatRoomFeatures,
    ChatRoomFooter,
    ChatRoomMetadata,
    ChatRoomPreview,
    ChatRoomRegistrationStatus,
    ChatUserAction,
    HostChatCreateRoomRequest,
    HostChatRoomEventsSubscribeItem,
    ProductChatEditHistoryQueryItem,
    ProductChatEditHistoryQueryRequest,
    ProductChatMessagesQueryItem,
    ProductChatMessagesQueryRequest,
    ProductChatOpenLinkItem,
    ProductChatOpenLinkRequest,
    ProductChatReactionsQueryItem,
    ProductChatReactionsQueryRequest,
    ProductChatSearchQueryItem,
    ProductChatSearchQueryRequest,
    ProductChatUserActionItem,
    ProductChatUserActionRequest,
} from "@parity/truapi";

import { FeatureUnavailableError, chatRoomErrorOf } from "./chat-errors.js";
import { type HostError, HostResponseDecodeError } from "./errors.js";
import { type Result, err, ok } from "./result.js";
import { getClient, subscribeWithInterrupt } from "./transport.js";
import { type ResultAsync, matchHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/**
 * Which parts of Chat Extension v2 the host's client carries. A host injects its
 * own client into every product it runs, so a product built against newer types
 * can meet an older client: read this instead of assuming a method exists.
 *
 * A method being present does not mean the core serves the feature to this
 * product: contact rooms and HOP media are the person chat product's, and call
 * buttons need a host that lists them. Such a refusal arrives as a
 * {@link FeatureUnavailableError} naming the feature.
 */
export interface ChatHostFeatures {
    /** `setConfig`, `setMetadata`, `setPreview`, `deleteRoom`, `updateFeed`, and the `messages_query` and `user_action` queries. */
    productSourceRooms: boolean;
    /** The `reactions_query` query (who reacted). */
    reactionDetails: boolean;
    /** `setFeatures`. */
    roomFeatures: boolean;
    /** `setCall`. */
    roomCalls: boolean;
    /** `subscribeRoomEvents`. */
    roomEvents: boolean;
    /** `setContact`. Served to the person chat product only. */
    contactRooms: boolean;
    /** The `search_query` query. */
    search: boolean;
    /** The `edit_history` query. */
    editHistory: boolean;
    /** The `open_link` query. */
    openLink: boolean;
    /** `getCallMedia()`. */
    callMedia: boolean;
}

/** The {@link ChatHostFeatures} of a client. */
export function chatHostFeatures(client: TrUApiClient): ChatHostFeatures {
    const chat = client.chat as Partial<TrUApiClient["chat"]> | undefined;
    const has = (name: keyof TrUApiClient["chat"]) => typeof chat?.[name] === "function";
    return {
        productSourceRooms:
            has("setRoomConfig") &&
            has("updateFeed") &&
            has("onMessagesQuery") &&
            has("onUserAction"),
        reactionDetails: has("onReactionsQuery"),
        roomFeatures: has("setRoomFeatures"),
        roomCalls: has("setRoomCall"),
        roomEvents: has("roomEventsSubscribe"),
        contactRooms: has("setRoomContact"),
        search: has("onSearchQuery"),
        editHistory: has("onEditHistory"),
        openLink: has("onOpenLink"),
        callMedia:
            typeof (client.callMedia as Partial<TrUApiClient["callMedia"]> | undefined)?.start ===
            "function",
    };
}

/** The rooms of a product. Obtain one with {@link getChatRooms} or {@link createChatRooms}. */
export interface ChatRooms {
    /** What the host's client carries. */
    readonly features: ChatHostFeatures;
    /**
     * Create a room, or find it again. An existing room answers `"Exists"` and keeps
     * every declaration the host stored for it. A new room is a host-store room with
     * the text input until the product declares otherwise; declare its configuration
     * right after.
     */
    createRoom(
        request: HostChatCreateRoomRequest,
    ): Promise<Result<ChatRoomRegistrationStatus, HostError>>;
    /** Delete a room and everything the host holds for it. Succeeds for a room that does not exist. */
    deleteRoom(roomId: string): Promise<Result<void, HostError>>;
    /** Declare which parts of a room the product serves. Replaces the previous configuration. */
    setConfig(roomId: string, config: ChatRoomConfig): Promise<Result<void, HostError>>;
    /** Replace a room's name and description. */
    setMetadata(roomId: string, metadata: ChatRoomMetadata): Promise<Result<void, HostError>>;
    /** Replace how a room appears in the chat list. At most 5 per second per room. */
    setPreview(roomId: string, preview: ChatRoomPreview): Promise<Result<void, HostError>>;
    /** Set what a room shows below its messages. */
    setFooter(roomId: string, footer: ChatRoomFooter): Promise<Result<void, HostError>>;
    /** Declare a room's optional features. Replaces the previous declaration whole. */
    setFeatures(roomId: string, features: ChatRoomFeatures): Promise<Result<void, HostError>>;
    /** Show, change or clear (`undefined`) the call of a room. Needs `call_buttons`; at most 2 per second per room. */
    setCall(roomId: string, call: ChatRoomCall | undefined): Promise<Result<void, HostError>>;
    /**
     * Set the person a room is a conversation with, so the host draws it as its own
     * person-to-person chat. Served to the person chat product (`contact_rooms`)
     * only; any other product gets a {@link FeatureUnavailableError}.
     */
    setContact(roomId: string, contact: ChatRoomContact): Promise<Result<void, HostError>>;
    /** Push one change to a room's messages. At most 20 per second per room. */
    updateFeed(roomId: string, update: ChatFeedUpdate): Promise<Result<void, HostError>>;
    /**
     * Post one message into a host-store room, the first Chat surface's way: the host
     * stores it with the origin `"product"` and gives its id. `alt` is the line a host
     * shows where it lists the message instead of drawing it. Refused in a
     * product-source room.
     */
    postMessage(
        roomId: string,
        payload: ChatMessageContent,
        options?: { alt?: string },
    ): Promise<Result<string, HostError>>;
    /**
     * What the user does with the added features of the product's rooms: the call
     * events. One upstream subscription serves every listener; the host keeps up to
     * 64 events while none is open and sends them when one opens.
     */
    subscribeRoomEvents(
        callback: (item: HostChatRoomEventsSubscribeItem) => void,
    ): HostSubscription;
}

type CallPayload = Parameters<typeof chatRoomErrorOf>[1];

/** Folds a host call into a `Result`, with the chat-specific errors of {@link chatRoomErrorOf}. */
function settle<T, U>(
    result: ResultAsync<T, CallPayload>,
    call: string,
    map: (value: T) => U,
): Promise<Result<U, HostError>> {
    return new Promise((resolve) => {
        matchHostResult(
            result,
            call,
            (value) => resolve(ok(map(value))),
            (error) =>
                resolve(
                    err(
                        error instanceof HostResponseDecodeError
                            ? error
                            : chatRoomErrorOf(call, error),
                    ),
                ),
        );
    });
}

function unavailable(call: string): Promise<Result<never, HostError>> {
    return Promise.resolve(err(new FeatureUnavailableError(call)));
}

interface RoomEventListener {
    next(item: HostChatRoomEventsSubscribeItem): void;
    interrupt?: (reason?: unknown) => void;
}

/**
 * The {@link ChatRooms} of a client. Products normally use {@link getChatRooms};
 * this form is for code that holds its own client, such as tests.
 */
export function createChatRooms(client: TrUApiClient): ChatRooms {
    const chat = client.chat;
    const features = chatHostFeatures(client);
    const listeners = new Set<RoomEventListener>();
    let upstream: HostSubscription | undefined;

    const startUpstream = () => {
        if (upstream || !features.roomEvents) return;
        const subscription = subscribeWithInterrupt(chat.roomEventsSubscribe(), (item) => {
            for (const listener of [...listeners]) listener.next(item);
        });
        subscription.onInterrupt((reason) => {
            if (upstream === subscription) upstream = undefined;
            for (const listener of [...listeners]) listener.interrupt?.(reason);
        });
        upstream = subscription;
    };

    const stopUpstreamIfUnused = () => {
        if (listeners.size > 0) return;
        upstream?.unsubscribe();
        upstream = undefined;
    };

    const unit = () => undefined;

    return {
        features,
        createRoom(request) {
            return settle(chat.createRoom(request), "createRoom", (response) => response.status);
        },
        deleteRoom(roomId) {
            if (!features.productSourceRooms) return unavailable("deleteRoom");
            return settle(chat.deleteRoom({ roomId }), "deleteRoom", unit);
        },
        setConfig(roomId, config) {
            if (!features.productSourceRooms) return unavailable("setRoomConfig");
            return settle(chat.setRoomConfig({ roomId, config }), "setRoomConfig", unit);
        },
        setMetadata(roomId, metadata) {
            if (!features.productSourceRooms) return unavailable("setRoomMetadata");
            return settle(chat.setRoomMetadata({ roomId, metadata }), "setRoomMetadata", unit);
        },
        setPreview(roomId, preview) {
            if (!features.productSourceRooms) return unavailable("setRoomPreview");
            return settle(chat.setRoomPreview({ roomId, preview }), "setRoomPreview", unit);
        },
        setFooter(roomId, footer) {
            return settle(chat.setRoomFooter({ roomId, footer }), "setRoomFooter", unit);
        },
        setFeatures(roomId, roomFeatures) {
            if (!features.roomFeatures) return unavailable("setRoomFeatures");
            return settle(
                chat.setRoomFeatures({ roomId, features: roomFeatures }),
                "setRoomFeatures",
                unit,
            );
        },
        setCall(roomId, call) {
            if (!features.roomCalls) return unavailable("setRoomCall");
            return settle(
                chat.setRoomCall(call ? { roomId, call } : { roomId }),
                "setRoomCall",
                unit,
            );
        },
        setContact(roomId, contact) {
            if (!features.contactRooms) return unavailable("contact_rooms");
            return settle(chat.setRoomContact({ roomId, contact }), "setRoomContact", unit);
        },
        updateFeed(roomId, update) {
            if (!features.productSourceRooms) return unavailable("updateFeed");
            return settle(chat.updateFeed({ roomId, update }), "updateFeed", unit);
        },
        postMessage(roomId, payload, options) {
            return settle(
                chat.postMessage({
                    roomId,
                    payload,
                    ...(options?.alt !== undefined ? { alt: options.alt } : {}),
                }),
                "postMessage",
                (response) => response.messageId,
            );
        },
        subscribeRoomEvents(callback) {
            const listener: RoomEventListener = { next: callback };
            let active = true;
            listeners.add(listener);
            startUpstream();
            return {
                unsubscribe() {
                    if (!active) return;
                    active = false;
                    listeners.delete(listener);
                    stopUpstreamIfUnused();
                },
                onInterrupt(interrupt) {
                    listener.interrupt = interrupt;
                    if (!features.roomEvents) {
                        queueMicrotask(() =>
                            interrupt(new FeatureUnavailableError("roomEventsSubscribe")),
                        );
                    }
                    return () => {
                        if (listener.interrupt === interrupt) listener.interrupt = undefined;
                    };
                },
            };
        },
    };
}

/**
 * The rooms of this product, or `null` outside a host container.
 *
 * @example
 * ```ts
 * import { getChatRooms } from "@parity/product-sdk-host";
 *
 * const rooms = await getChatRooms();
 * if (rooms) {
 *     await rooms.createRoom({ roomId: "support", name: "Support", icon: "" });
 *     await rooms.setConfig("support", { productSource: true, reactionDetails: false, reportSeen: true });
 * }
 * ```
 */
export async function getChatRooms(): Promise<ChatRooms | null> {
    const client = await getClient();
    return client ? createChatRooms(client) : null;
}

/**
 * The deeplink of a room, `/-/chat/<room_id>`: a notification carrying it is the
 * room's notification, which the host titles with the room's name (or contact) and
 * opens the room on a tap. The room id goes in as the product named it, since the
 * host matches it against the product's rooms.
 */
export function roomDeeplink(roomId: string): string {
    return `/-/chat/${roomId}`;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;
    const { okAsync, errAsync } = await import("neverthrow");

    const observable = <T>(items: T[]) => {
        let observer: { next?(item: T): void; error?(reason: unknown): void } = {};
        return {
            emit: (item: T) => observer.next?.(item),
            fail: (reason: unknown) => observer.error?.(reason),
            subscribe: vi.fn((next: typeof observer) => {
                observer = next;
                for (const item of items) next.next?.(item);
                return { subscriptionId: "room-events", unsubscribe: vi.fn() };
            }),
        };
    };

    describe("createChatRooms", () => {
        test("an older client without v2 methods refuses without calling", async () => {
            const rooms = createChatRooms({
                chat: { createRoom: () => okAsync({ status: "New" }) },
            } as unknown as TrUApiClient);
            expect(rooms.features.productSourceRooms).toBe(false);
            expect(await rooms.createRoom({ roomId: "a", name: "A", icon: "" })).toEqual(ok("New"));
            const result = await rooms.updateFeed("a", {
                tag: "StatusChanged",
                value: { messageId: "m", status: "Sent" },
            });
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBeInstanceOf(FeatureUnavailableError);
        });

        test("a refusal carries the host's failure", async () => {
            const updateFeed = vi.fn(() =>
                errAsync({ tag: "Domain", value: { tag: "V1", value: { tag: "NotOwner" } } }),
            );
            const rooms = createChatRooms({
                chat: {
                    setRoomConfig: vi.fn(),
                    onMessagesQuery: vi.fn(),
                    onUserAction: vi.fn(),
                    updateFeed,
                },
            } as unknown as TrUApiClient);
            const update: ChatFeedUpdate = {
                tag: "Edited",
                value: {
                    messageId: "m",
                    body: { tag: "Text", value: { text: "x" } },
                    editedAt: 1n,
                },
            };
            const result = await rooms.updateFeed("room", update);
            expect(updateFeed).toHaveBeenCalledWith({ roomId: "room", update });
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.message).toBe("updateFeed: NotOwner");
        });

        test("setCall without a call clears it", async () => {
            const setRoomCall = vi.fn(() => okAsync(undefined));
            const rooms = createChatRooms({ chat: { setRoomCall } } as unknown as TrUApiClient);
            expect(await rooms.setCall("room", undefined)).toEqual(ok(undefined));
            expect(setRoomCall).toHaveBeenCalledWith({ roomId: "room" });
        });

        test("postMessage gives the host's id and sends alt only when given", async () => {
            const postMessage = vi.fn(() => okAsync({ messageId: "h1" }));
            const rooms = createChatRooms({ chat: { postMessage } } as unknown as TrUApiClient);
            const payload: ChatMessageContent = { tag: "Text", value: { text: "hi" } };
            expect(await rooms.postMessage("room", payload)).toEqual(ok("h1"));
            await rooms.postMessage("room", payload, { alt: "a greeting" });
            expect(postMessage.mock.calls).toEqual([
                [{ roomId: "room", payload }],
                [{ roomId: "room", payload, alt: "a greeting" }],
            ]);
        });

        test("room events fan out from one upstream subscription", () => {
            const stream = observable<HostChatRoomEventsSubscribeItem>([]);
            const roomEventsSubscribe = vi.fn(() => stream);
            const rooms = createChatRooms({
                chat: { roomEventsSubscribe },
            } as unknown as TrUApiClient);
            const first: HostChatRoomEventsSubscribeItem[] = [];
            const second: HostChatRoomEventsSubscribeItem[] = [];
            const a = rooms.subscribeRoomEvents((item) => first.push(item));
            rooms.subscribeRoomEvents((item) => second.push(item));
            const item: HostChatRoomEventsSubscribeItem = {
                roomId: "room",
                event: { tag: "CallEnded", value: { callId: "c" } },
            };
            stream.emit(item);
            a.unsubscribe();
            stream.emit(item);
            expect(roomEventsSubscribe).toHaveBeenCalledOnce();
            expect(first).toEqual([item]);
            expect(second).toEqual([item, item]);
        });

        test("an interrupted upstream reaches the listeners and the next subscribe starts another", () => {
            const stream = observable<HostChatRoomEventsSubscribeItem>([]);
            const roomEventsSubscribe = vi.fn(() => stream);
            const rooms = createChatRooms({
                chat: { roomEventsSubscribe },
            } as unknown as TrUApiClient);
            const interrupted = vi.fn();
            rooms.subscribeRoomEvents(() => {}).onInterrupt(interrupted);
            stream.fail("gone");
            expect(interrupted).toHaveBeenCalledWith("gone");
            rooms.subscribeRoomEvents(() => {});
            expect(roomEventsSubscribe).toHaveBeenCalledTimes(2);
        });
    });

    test("roomDeeplink names the room", () => {
        expect(roomDeeplink("dm-ab")).toBe("/-/chat/dm-ab");
    });
}
