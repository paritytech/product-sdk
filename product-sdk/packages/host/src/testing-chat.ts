// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A stand-in for the host's side of Chat Extension v2, for tests of chat products.
 *
 * `createFakeChatHost()` plays the host and its core: it keeps what the product
 * declares for each room and the feed updates it pushes, applies the room rules,
 * bounds and rates of the RFCs as the core does before a host sees a call, and
 * asks the product the host's questions (`openRoom`, `userSends`, `search`, ...)
 * the way a host screen would. It also models the call media, the worker
 * operations and the notifications a chat product uses.
 *
 * Pass it to `createFakeTruApiClient({ chatHost })` or `createFakeHost({ chatHost })`.
 *
 * @module
 */
import type {
    ChatFeedUpdate,
    ChatMessage,
    ChatMessageBody,
    ChatMessageContent,
    ChatPageAnchor,
    ChatRoomCall,
    ChatRoomConfig,
    ChatRoomContact,
    ChatRoomEvent,
    ChatRoomFeatures,
    ChatRoomFooter,
    ChatRoomMetadata,
    ChatRoomPreview,
    ChatUserAction,
    HostChatActionSubscribeItem,
    HostChatListSubscribeItem,
    HostChatPostMessageRequest,
    HostChatRegisterBotRequest,
    HostChatRoomEventsSubscribeItem,
    HostInitiatedSubscriptionHandler,
    HostPushNotificationRequest,
    Observer,
    ProductChatEditHistoryQueryItem,
    ProductChatMessagesQueryItem,
    ProductChatOpenLinkItem,
    ProductChatReactionsQueryItem,
    ProductChatSearchQueryItem,
    ProductChatUserActionItem,
    TrUApiClient,
} from "@parity/truapi";
import { type Clock, systemClock } from "@parity/product-sdk-utils";
import { errAsync, okAsync } from "neverthrow";

import { makeObservable } from "./testing-observable.js";

type PublicSurface<C> = { [K in keyof C]: C[K] };

/** The feature names a host lists to the core (Chat Extension v2 additions, "Capabilities"). */
export type ChatCapability =
    | "product_source_rooms"
    | "reaction_details"
    | "hop_attachments"
    | "call_buttons"
    | "contact_rooms";

/** Options of {@link createFakeChatHost}. */
export interface FakeChatHostOptions {
    /**
     * The features the host lists. Default: `product_source_rooms`, `reaction_details`
     * and `call_buttons`, plus `contact_rooms` and `hop_attachments` for the person
     * chat product.
     */
    capabilities?: ChatCapability[];
    /**
     * The product is the person chat product (the `chat` label): the core keeps
     * `contact_rooms` and `hop_attachments` for it only. Default `false`.
     */
    personChatProduct?: boolean;
    /**
     * Chat methods the host's client lacks, to play a host older than the product.
     * The double leaves them off its `chat` object.
     */
    omit?: (keyof TrUApiClient["chat"])[];
    /** Times the rate limits and call consent. */
    clock?: Clock;
}

/** What the product declared for one room, and what it pushed into it. */
export interface FakeChatRoom {
    readonly roomId: string;
    name: string;
    icon: string;
    config?: ChatRoomConfig;
    metadata?: ChatRoomMetadata;
    preview?: ChatRoomPreview;
    footer: ChatRoomFooter;
    features?: ChatRoomFeatures;
    call?: ChatRoomCall;
    contact?: ChatRoomContact;
    /** Every feed update the host accepted, in order. */
    readonly feed: ChatFeedUpdate[];
    /** The messages a host-store room keeps, by id. */
    readonly stored: Map<string, ChatMessage>;
    /** What `postMessage` posted, in order, with the ids the host gave. */
    readonly posted: { messageId: string; request: HostChatPostMessageRequest }[];
}

/** The product's answer to one host question: its item, or the reason it interrupted with. */
export type FakeQueryOutcome<Item> = { ok: true; value: Item } | { ok: false; reason: unknown };

/** One call of the host's call engine. */
export type FakeCallMediaCall =
    | { kind: "start"; roomId: string; callId: string; video: boolean; offerer: boolean }
    | { kind: "signal"; roomId: string; callId: string; signal: `0x${string}` }
    | { kind: "stop"; roomId: string; callId: string };

/** The double. Its `chat`, `callMedia`, `worker` and `notifications` plug into a fake client. */
export interface FakeChatHost {
    readonly chat: PublicSurface<TrUApiClient["chat"]>;
    readonly callMedia: PublicSurface<TrUApiClient["callMedia"]>;
    readonly worker: PublicSurface<TrUApiClient["worker"]>;
    readonly notifications: PublicSurface<TrUApiClient["notifications"]>;
    /** The features the host lists. */
    readonly capabilities: readonly ChatCapability[];
    /** The rooms the product created, by id. */
    readonly rooms: ReadonlyMap<string, FakeChatRoom>;
    /** The room, or a thrown error naming it when the product created none. */
    room(roomId: string): FakeChatRoom;
    /** The bots the product registered. */
    readonly bots: readonly HostChatRegisterBotRequest[];
    /** The host's call engine calls, in order. */
    readonly callMediaLog: readonly FakeCallMediaCall[];
    /** The notifications the product sent, in order. */
    readonly notificationsSent: readonly HostPushNotificationRequest[];
    /** Host operations begun and not yet ended. */
    readonly openOperations: number;

    /** Opens a room screen: `messages_query` with `Before { cursor: None }`. */
    openRoom(
        roomId: string,
        pageSize?: number,
    ): Promise<FakeQueryOutcome<ProductChatMessagesQueryItem>>;
    /** Asks one page of a product-source room. */
    page(
        roomId: string,
        anchor: ChatPageAnchor,
        pageSize?: number,
    ): Promise<FakeQueryOutcome<ProductChatMessagesQueryItem>>;
    /** Reports a user action in a product-source room. */
    userAction(
        roomId: string,
        action: ChatUserAction,
    ): Promise<FakeQueryOutcome<ProductChatUserActionItem>>;
    /**
     * The user sends a message. In a product-source room this is `user_action`
     * `NewMessage` under a message id the host chose (a UUID unless given); in a
     * host-store room it is stored and reaches `action_subscribe` as `MessagePosted`.
     */
    userSends(
        roomId: string,
        body: ChatMessageBody,
        options?: { replyTo?: string; messageId?: string | null; timestamp?: bigint },
    ): Promise<FakeQueryOutcome<ProductChatUserActionItem>>;
    /** Asks who reacted to a message. */
    reactions(
        roomId: string,
        messageId: string,
    ): Promise<FakeQueryOutcome<ProductChatReactionsQueryItem>>;
    /** Searches a product-source room. */
    search(
        roomId: string,
        text: string,
        options?: { cursor?: string; pageSize?: number },
    ): Promise<FakeQueryOutcome<ProductChatSearchQueryItem>>;
    /** Asks the edit history of a message. */
    editHistory(
        roomId: string,
        messageId: string,
    ): Promise<FakeQueryOutcome<ProductChatEditHistoryQueryItem>>;
    /** Gives the product what the user opened from an entry point of the host. */
    openLink(roomId: string, payload: string): Promise<FakeQueryOutcome<ProductChatOpenLinkItem>>;
    /** Sends a room event (a call button, an answer, a signal of the call engine). Queued while no one subscribed. */
    emitRoomEvent(roomId: string, event: ChatRoomEvent): void;
    /** Sends a first-surface action (`MessagePosted`, `ActionTriggered`, `Command`) to `action_subscribe`. */
    emitAction(item: HostChatActionSubscribeItem): void;
}

const ENCODER = new TextEncoder();
const IDENTIFIER_BYTES = 256;
const DISPLAY_TEXT_BYTES = 256;
const DESCRIPTION_BYTES = 1024;
const MESSAGE_TEXT_BYTES = 16 * 1024;
const MEDIA_PER_MESSAGE = 32;
const REACTIONS_PER_MESSAGE = 64;
const PAGE_SIZE_MAX = 100;
const SEARCH_PAGE_SIZE_MAX = 50;
const CURSOR_BYTES = 1024;
const EDIT_HISTORY_MAX = 100;
const LINK_PAYLOAD_BYTES = 8 * 1024;
const ROOM_EVENT_QUEUE = 64;
const CALL_CONSENT_MS = 180_000;
/** Calls per second per room the core allows. */
const RATES = { updateFeed: 20, setRoomPreview: 5, setRoomCall: 2, setRoomContact: 5 } as const;

const bytes = (text: string) => ENCODER.encode(text).length;

function domain<F>(failure: F) {
    return errAsync({ tag: "Domain" as const, value: { tag: "V1" as const, value: failure } });
}

function unknown(reason: string) {
    return domain({ tag: "Unknown" as const, value: { reason } });
}

/** `post_message` answers in its `V2` envelope. */
function postFailure(
    failure: { tag: "MessageTooLarge" } | { tag: "Unknown"; value: { reason: string } },
) {
    return errAsync({ tag: "Domain" as const, value: { tag: "V2" as const, value: failure } });
}

function uuid(): string {
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    random[6] = ((random[6] ?? 0) & 0x0f) | 0x40;
    random[8] = ((random[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The first bound of the base RFC's "Limits" a body breaks, or undefined. */
function bodyProblem(body: ChatMessageBody): "MessageTooLarge" | string | undefined {
    if (body.tag === "Text")
        return bytes(body.value.text) > MESSAGE_TEXT_BYTES ? "MessageTooLarge" : undefined;
    if (body.tag !== "RichText") return undefined;
    if (body.value.text !== undefined && bytes(body.value.text) > MESSAGE_TEXT_BYTES)
        return "MessageTooLarge";
    if (body.value.media.length > MEDIA_PER_MESSAGE) return "media";
    for (const item of body.value.media) {
        const meta = item.value.meta;
        if (bytes(meta.mimeType) > DISPLAY_TEXT_BYTES) return "mime_type";
        if (meta.alt !== undefined && bytes(meta.alt) > DISPLAY_TEXT_BYTES) return "alt";
        if (meta.placeholder !== undefined && bytes(meta.placeholder) > DISPLAY_TEXT_BYTES)
            return "placeholder";
        if (item.tag === "File" && bytes(item.value.fileName) > DISPLAY_TEXT_BYTES)
            return "file_name";
    }
    return undefined;
}

/** The first bound a message breaks, or undefined. */
function messageProblem(message: ChatMessage): string | undefined {
    if (bytes(message.messageId) > IDENTIFIER_BYTES) return "message_id";
    if (bytes(message.origin.participantId) > IDENTIFIER_BYTES) return "participant_id";
    if (message.reactions.length > REACTIONS_PER_MESSAGE) return "reactions";
    const emoji = new Set<string>();
    for (const reaction of message.reactions) {
        if (bytes(reaction.emoji) > DISPLAY_TEXT_BYTES) return "emoji";
        if (emoji.has(reaction.emoji)) return "reactions";
        emoji.add(reaction.emoji);
    }
    return bodyProblem(message.body);
}

/** Creates a {@link FakeChatHost}. */
export function createFakeChatHost(options: FakeChatHostOptions = {}): FakeChatHost {
    const clock = options.clock ?? systemClock;
    const personChatProduct = options.personChatProduct ?? false;
    const listed: ChatCapability[] =
        options.capabilities ??
        (personChatProduct
            ? [
                  "product_source_rooms",
                  "reaction_details",
                  "call_buttons",
                  "contact_rooms",
                  "hop_attachments",
              ]
            : ["product_source_rooms", "reaction_details", "call_buttons"]);
    // The core drops what it cannot back for this product.
    const capabilities = listed.filter(
        (name) => personChatProduct || (name !== "contact_rooms" && name !== "hop_attachments"),
    );
    const serves = (name: ChatCapability) => capabilities.includes(name);

    const rooms = new Map<string, FakeChatRoom>();
    const bots: HostChatRegisterBotRequest[] = [];
    const callMediaLog: FakeCallMediaCall[] = [];
    const notificationsSent: HostPushNotificationRequest[] = [];
    const consent = new Map<string, number>();
    const calls = new Map<string, number[]>();
    const handlers = new Map<string, HostInitiatedSubscriptionHandler<unknown, unknown, unknown>>();
    const roomEventQueue: HostChatRoomEventsSubscribeItem[] = [];
    let roomEventObserver: Partial<Observer<HostChatRoomEventsSubscribeItem, unknown>> | undefined;
    const actionObservers = new Set<Partial<Observer<HostChatActionSubscribeItem, unknown>>>();
    const listObservers = new Set<Partial<Observer<HostChatListSubscribeItem, unknown>>>();
    let postedCount = 0;
    let operationCount = 0;
    const operations = new Set<number>();

    const listItem = (): HostChatListSubscribeItem => ({
        rooms: [...rooms.keys()].map((roomId) => ({ roomId, participatingAs: "RoomHost" })),
    });
    const notifyList = () => {
        for (const observer of listObservers) observer.next?.(listItem());
    };

    /** Whether one more call of `method` on `roomId` stays within its rate. */
    const withinRate = (method: keyof typeof RATES, roomId: string): boolean => {
        const key = `${method}:${roomId}`;
        const now = clock.nowMs();
        const recent = (calls.get(key) ?? []).filter((at) => now - at < 1000);
        if (recent.length >= RATES[method]) {
            calls.set(key, recent);
            return false;
        }
        recent.push(now);
        calls.set(key, recent);
        return true;
    };

    const isProductSource = (room: FakeChatRoom) =>
        room.config?.productSource === true && serves("product_source_rooms");

    const hostRoom = (roomId: string) => rooms.get(roomId);

    const register =
        (name: string) =>
        <Request, Item, Reason>(
            handler: HostInitiatedSubscriptionHandler<Request, Item, Reason>,
        ) => {
            handlers.set(
                name,
                handler as unknown as HostInitiatedSubscriptionHandler<unknown, unknown, unknown>,
            );
            return {
                unsubscribe: () => {
                    if (handlers.get(name) === (handler as unknown)) handlers.delete(name);
                },
            };
        };

    /** Asks one question and takes the first item or interrupt, then stops the stream, as a host does. */
    const ask = <Item>(name: string, request: unknown): Promise<FakeQueryOutcome<Item>> => {
        const handler = handlers.get(name);
        if (!handler) return Promise.resolve({ ok: false, reason: { tag: "NoHandler", name } });
        return new Promise((resolve) => {
            let settled = false;
            let cleanup: (() => void) | undefined;
            const finish = (outcome: FakeQueryOutcome<Item>) => {
                if (settled) return;
                settled = true;
                resolve(outcome);
                queueMicrotask(() => cleanup?.());
            };
            const stop = handler(
                request,
                (item) => finish({ ok: true, value: item as Item }),
                (reason) => finish({ ok: false, reason }),
            );
            if (typeof stop === "function") cleanup = stop;
        });
    };

    const notAvailable = {
        ok: false as const,
        reason: { tag: "Domain", value: { tag: "V1", value: { tag: "NotAvailable" } } },
    };
    const coreUnknown = (reason: string) => ({
        ok: false as const,
        reason: {
            tag: "Domain",
            value: { tag: "V1", value: { tag: "Unknown", value: { reason } } },
        },
    });
    const overBound = (field: string) =>
        coreUnknown(`the product's answer is over the bound of ${field}`);

    const requireProductSource = (roomId: string) => {
        const room = hostRoom(roomId);
        if (!room) return coreUnknown(`unknown room ${roomId}`);
        if (!isProductSource(room)) return undefined;
        return room;
    };

    const chatSurface: PublicSurface<TrUApiClient["chat"]> = {
        createRoom: ({ roomId, name, icon }: { roomId: string; name: string; icon: string }) => {
            if (bytes(roomId) > IDENTIFIER_BYTES || roomId.length === 0) return unknown("room_id");
            if (bytes(name) > DISPLAY_TEXT_BYTES) return unknown("name");
            if (rooms.has(roomId)) return okAsync({ status: "Exists" as const });
            rooms.set(roomId, {
                roomId,
                name,
                icon,
                footer: "TextInput",
                feed: [],
                stored: new Map(),
                posted: [],
            });
            notifyList();
            return okAsync({ status: "New" as const });
        },
        registerBot: (request: HostChatRegisterBotRequest) => {
            if (bots.some((bot) => bot.botId === request.botId))
                return okAsync({ status: "Exists" as const });
            bots.push(request);
            return okAsync({ status: "New" as const });
        },
        listSubscribe: () =>
            makeObservable<HostChatListSubscribeItem, never>((observer) => {
                const entry = observer ?? {};
                listObservers.add(entry);
                queueMicrotask(() => entry.next?.(listItem()));
                return {
                    subscriptionId: "fake-chat-list",
                    unsubscribe: () => listObservers.delete(entry),
                };
            }),
        postMessage: (request: HostChatPostMessageRequest) => {
            const room = hostRoom(request.roomId);
            if (!room)
                return postFailure({
                    tag: "Unknown",
                    value: { reason: `unknown room ${request.roomId}` },
                });
            if (isProductSource(room))
                return postFailure({
                    tag: "Unknown",
                    value: { reason: "post_message in a product-source room" },
                });
            const text = request.payload.tag === "Text" ? request.payload.value.text : undefined;
            if (text !== undefined && bytes(text) > MESSAGE_TEXT_BYTES)
                return postFailure({ tag: "MessageTooLarge" });
            postedCount += 1;
            const messageId = `posted-${postedCount}`;
            room.posted.push({ messageId, request });
            return okAsync({ messageId });
        },
        actionSubscribe: () =>
            makeObservable<HostChatActionSubscribeItem, never>((observer) => {
                const entry = observer ?? {};
                actionObservers.add(entry);
                return {
                    subscriptionId: "fake-chat-actions",
                    unsubscribe: () => actionObservers.delete(entry),
                };
            }),
        setRoomFooter: ({ roomId, footer }: { roomId: string; footer: ChatRoomFooter }) => {
            const room = hostRoom(roomId);
            if (!room) return domain({ tag: "UnknownRoom" as const });
            room.footer = footer;
            return okAsync(undefined);
        },
        setRoomMetadata: ({ roomId, metadata }: { roomId: string; metadata: ChatRoomMetadata }) => {
            const room = hostRoom(roomId);
            if (!room) return domain({ tag: "UnknownRoom" as const });
            if (bytes(metadata.name) > DISPLAY_TEXT_BYTES) return unknown("name");
            if (
                metadata.description !== undefined &&
                bytes(metadata.description) > DESCRIPTION_BYTES
            )
                return unknown("description");
            room.metadata = metadata;
            return okAsync(undefined);
        },
        setRoomPreview: ({ roomId, preview }: { roomId: string; preview: ChatRoomPreview }) => {
            const room = hostRoom(roomId);
            if (!room) return domain({ tag: "UnknownRoom" as const });
            if (!withinRate("setRoomPreview", roomId))
                return domain({ tag: "RateLimited" as const });
            for (const message of [
                preview.lastMessage,
                preview.lastCall,
                preview.lastReaction?.message,
            ]) {
                const problem = message ? messageProblem(message) : undefined;
                if (problem) return unknown(problem === "MessageTooLarge" ? "text" : problem);
            }
            room.preview = preview;
            return okAsync(undefined);
        },
        deleteRoom: ({ roomId }: { roomId: string }) => {
            if (rooms.delete(roomId)) notifyList();
            return okAsync(undefined);
        },
        updateFeed: ({ roomId, update }: { roomId: string; update: ChatFeedUpdate }) => {
            const room = hostRoom(roomId);
            if (!room) return domain({ tag: "UnknownRoom" as const });
            if (!withinRate("updateFeed", roomId)) return domain({ tag: "RateLimited" as const });
            const message =
                update.tag === "New" || update.tag === "Replaced" ? update.value : undefined;
            const problem = message
                ? messageProblem(message)
                : update.tag === "Edited"
                  ? bodyProblem(update.value.body)
                  : undefined;
            if (problem === "MessageTooLarge") return domain({ tag: "MessageTooLarge" as const });
            if (problem) return unknown(problem);
            if (!isProductSource(room)) {
                // A host-store room keeps the messages, so the core checks them against what it holds.
                const stored = room.stored;
                switch (update.tag) {
                    case "New":
                        if (update.value.origin.participantId === "user")
                            return domain({ tag: "NotOwner" as const });
                        if (stored.has(update.value.messageId))
                            return domain({ tag: "DuplicateMessage" as const });
                        stored.set(update.value.messageId, update.value);
                        break;
                    case "Edited": {
                        const target = stored.get(update.value.messageId);
                        if (!target) return domain({ tag: "UnknownMessage" as const });
                        if (target.origin.participantId === "user")
                            return domain({ tag: "NotOwner" as const });
                        stored.set(target.messageId, {
                            ...target,
                            body: update.value.body,
                            editedAt: update.value.editedAt,
                        });
                        break;
                    }
                    case "Replaced":
                        if (!stored.has(update.value.messageId))
                            return domain({ tag: "UnknownMessage" as const });
                        stored.set(update.value.messageId, update.value);
                        break;
                    default:
                        if (!stored.has(update.value.messageId))
                            return domain({ tag: "UnknownMessage" as const });
                }
            }
            room.feed.push(update);
            return okAsync(undefined);
        },
        onMessagesQuery: register("messages"),
        onUserAction: register("userAction"),
        onReactionsQuery: register("reactions"),
        onSearchQuery: register("search"),
        setRoomFeatures: ({ roomId, features }: { roomId: string; features: ChatRoomFeatures }) => {
            const room = hostRoom(roomId);
            if (!room) return domain({ tag: "UnknownRoom" as const });
            // Stored whole, served features or not: a later host build applies them.
            room.features = features;
            return okAsync(undefined);
        },
        setRoomCall: ({ roomId, call }: { roomId: string; call?: ChatRoomCall }) => {
            const room = hostRoom(roomId);
            if (!room) return domain({ tag: "UnknownRoom" as const });
            if (!withinRate("setRoomCall", roomId)) return domain({ tag: "RateLimited" as const });
            if (call && !serves("call_buttons"))
                return unknown("this host does not serve call_buttons");
            if (call && bytes(call.value.callId) > IDENTIFIER_BYTES) return unknown("call_id");
            room.call = call;
            return okAsync(undefined);
        },
        roomEventsSubscribe: () =>
            makeObservable<HostChatRoomEventsSubscribeItem, never>((observer) => {
                // A second subscription replaces the first, and gets what was queued meanwhile.
                roomEventObserver?.complete?.();
                const entry = observer ?? {};
                roomEventObserver = entry;
                const queued = roomEventQueue.splice(0);
                queueMicrotask(() => {
                    for (const item of queued) entry.next?.(item);
                });
                return {
                    subscriptionId: "fake-room-events",
                    unsubscribe: () => {
                        if (roomEventObserver === entry) roomEventObserver = undefined;
                    },
                };
            }),
        onOpenLink: register("openLink"),
        setRoomContact: ({ roomId, contact }: { roomId: string; contact: ChatRoomContact }) => {
            const room = hostRoom(roomId);
            if (!room) return domain({ tag: "UnknownRoom" as const });
            if (!serves("contact_rooms")) return unknown("this host does not serve contact_rooms");
            if (!withinRate("setRoomContact", roomId))
                return domain({ tag: "RateLimited" as const });
            if (
                contact.username !== undefined &&
                (contact.username.length === 0 || bytes(contact.username) > DISPLAY_TEXT_BYTES)
            )
                return unknown("username");
            room.contact = contact;
            return okAsync(undefined);
        },
        onEditHistory: register("editHistory"),
        setRoomConfig: ({ roomId, config }: { roomId: string; config: ChatRoomConfig }) => {
            const room = hostRoom(roomId);
            if (!room) return domain({ tag: "UnknownRoom" as const });
            room.config = config;
            return okAsync(undefined);
        },
    };
    for (const name of options.omit ?? [])
        delete (chatSurface as Partial<typeof chatSurface>)[name];
    const chat = chatSurface;

    const callMedia: PublicSurface<TrUApiClient["callMedia"]> = {
        start: (request) => {
            const given = consent.get(request.roomId);
            if (given === undefined || clock.nowMs() - given > CALL_CONSENT_MS)
                return domain({ tag: "NotAllowed" as const });
            callMediaLog.push({ kind: "start", ...request });
            return okAsync({});
        },
        signal: (request) => {
            callMediaLog.push({ kind: "signal", ...request });
            return okAsync({});
        },
        stop: (request) => {
            callMediaLog.push({ kind: "stop", ...request });
            return okAsync({});
        },
    };

    const worker: PublicSurface<TrUApiClient["worker"]> = {
        beginOperation: () => {
            operationCount += 1;
            operations.add(operationCount);
            return okAsync({ id: operationCount });
        },
        endOperation: ({ id }) => {
            operations.delete(id);
            return okAsync(undefined);
        },
    };

    const notifications: PublicSurface<TrUApiClient["notifications"]> = {
        sendPushNotification: (request) => {
            notificationsSent.push(request);
            return okAsync({ id: notificationsSent.length });
        },
        cancelPushNotification: () => okAsync(undefined),
    };

    const page = async (roomId: string, anchor: ChatPageAnchor, pageSize = 50) => {
        const room = requireProductSource(roomId);
        if (room === undefined) {
            const stored = hostRoom(roomId)?.stored;
            return { ok: true as const, value: { messages: [...(stored?.values() ?? [])] } };
        }
        if ("ok" in room) return room;
        const size = Math.max(1, Math.min(PAGE_SIZE_MAX, pageSize));
        const outcome = await ask<ProductChatMessagesQueryItem>("messages", {
            roomId,
            anchor,
            pageSize: size,
        });
        if (outcome.ok) {
            if (outcome.value.messages.length > size) return overBound("page_size");
            if (outcome.value.next !== undefined && bytes(outcome.value.next) > CURSOR_BYTES)
                return overBound("cursor");
            for (const message of outcome.value.messages) {
                const problem = messageProblem(message);
                if (problem) return overBound(problem);
            }
        }
        return outcome;
    };

    const userAction = async (roomId: string, action: ChatUserAction) => {
        const room = hostRoom(roomId);
        if (!room) return coreUnknown(`unknown room ${roomId}`);
        if (!isProductSource(room)) return coreUnknown("user_action in a host-store room");
        if (action.tag === "Seen" && room.config?.reportSeen !== true)
            return coreUnknown("report_seen is off");
        return ask<ProductChatUserActionItem>("userAction", { roomId, action });
    };

    const host: FakeChatHost = {
        chat,
        callMedia,
        worker,
        notifications,
        capabilities,
        rooms,
        room(roomId) {
            const room = rooms.get(roomId);
            if (!room) throw new Error(`the product created no room ${roomId}`);
            return room;
        },
        bots,
        callMediaLog,
        notificationsSent,
        get openOperations() {
            return operations.size;
        },
        openRoom: (roomId, pageSize) => page(roomId, { tag: "Before", value: {} }, pageSize),
        page,
        userAction,
        async userSends(roomId, body, sendOptions = {}) {
            const room = hostRoom(roomId);
            if (room && !isProductSource(room)) {
                const content: ChatMessageContent =
                    body.tag === "Text"
                        ? { tag: "Text", value: { text: body.value.text } }
                        : { tag: "Text", value: { text: "" } };
                for (const observer of actionObservers)
                    observer.next?.({
                        roomId,
                        peer: "user",
                        payload: { tag: "MessagePosted", value: content },
                    });
                return { ok: true, value: { tag: "Acknowledged" } };
            }
            const messageId =
                sendOptions.messageId === null ? undefined : (sendOptions.messageId ?? uuid());
            return userAction(roomId, {
                tag: "NewMessage",
                value: {
                    body,
                    ...(sendOptions.replyTo !== undefined ? { replyTo: sendOptions.replyTo } : {}),
                    ...(messageId !== undefined ? { messageId } : {}),
                    timestamp: sendOptions.timestamp ?? BigInt(clock.nowMs()),
                },
            });
        },
        async reactions(roomId, messageId) {
            const room = hostRoom(roomId);
            if (!room) return coreUnknown(`unknown room ${roomId}`);
            if (room.config?.reactionDetails !== true || !serves("reaction_details"))
                return notAvailable;
            return ask<ProductChatReactionsQueryItem>("reactions", { roomId, messageId });
        },
        async search(roomId, text, searchOptions = {}) {
            const room = hostRoom(roomId);
            if (!room) return coreUnknown(`unknown room ${roomId}`);
            if (!isProductSource(room)) return notAvailable;
            const pageSize = searchOptions.pageSize ?? 20;
            if (text.length === 0) return coreUnknown("text");
            if (pageSize < 1 || pageSize > SEARCH_PAGE_SIZE_MAX) return coreUnknown("page_size");
            const outcome = await ask<ProductChatSearchQueryItem>("search", {
                roomId,
                text,
                ...(searchOptions.cursor !== undefined ? { cursor: searchOptions.cursor } : {}),
                pageSize,
            });
            if (outcome.ok && outcome.value.hits.length > pageSize) return overBound("page_size");
            return outcome;
        },
        async editHistory(roomId, messageId) {
            const room = hostRoom(roomId);
            if (!room) return coreUnknown(`unknown room ${roomId}`);
            if (!isProductSource(room)) return notAvailable;
            const outcome = await ask<ProductChatEditHistoryQueryItem>("editHistory", {
                roomId,
                messageId,
            });
            if (outcome.ok && outcome.value.revisions.length > EDIT_HISTORY_MAX)
                return overBound("revisions");
            return outcome;
        },
        async openLink(roomId, payload) {
            if (payload.length === 0 || bytes(payload) > LINK_PAYLOAD_BYTES)
                return coreUnknown("payload");
            const outcome = await ask<ProductChatOpenLinkItem>("openLink", { roomId, payload });
            if (
                outcome.ok &&
                outcome.value.roomId !== undefined &&
                bytes(outcome.value.roomId) > IDENTIFIER_BYTES
            )
                return overBound("room_id");
            return outcome;
        },
        emitRoomEvent(roomId, event) {
            if (
                event.tag === "CallRequested" ||
                (event.tag === "CallAnswered" && event.value.accept)
            )
                consent.set(roomId, clock.nowMs());
            const item = { roomId, event };
            if (roomEventObserver) {
                roomEventObserver.next?.(item);
                return;
            }
            roomEventQueue.push(item);
            if (roomEventQueue.length > ROOM_EVENT_QUEUE) roomEventQueue.shift();
        },
        emitAction(item) {
            for (const observer of actionObservers) observer.next?.(item);
        },
    };
    return host;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { ManualClock } = await import("@parity/product-sdk-utils/testing");

    const text = (value: string): ChatMessageBody => ({ tag: "Text", value: { text: value } });
    const message = (
        messageId: string,
        participantId = "product",
        body = text("hi"),
    ): ChatMessage => ({
        messageId,
        origin: { participantId },
        timestamp: 1n,
        body,
        status: "Sent",
        reactions: [],
        request: false,
    });
    const failure = async (result: unknown) => {
        const settled = (await (result as Promise<unknown>)) as {
            isErr(): boolean;
            error?: unknown;
        };
        return settled.isErr() ? settled.error : undefined;
    };

    describe("room rules", () => {
        test("an existing room answers Exists and keeps its declarations", async () => {
            const host = createFakeChatHost();
            await host.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            await host.chat.setRoomConfig({
                roomId: "r",
                config: { productSource: true, reactionDetails: false, reportSeen: false },
            });
            const again = await host.chat.createRoom({ roomId: "r", name: "Other", icon: "" });
            expect(again.isOk() && again.value.status).toBe("Exists");
            expect(host.room("r").config?.productSource).toBe(true);
            expect(host.room("r").name).toBe("R");
        });

        test("calls on a room the product did not create are UnknownRoom", async () => {
            const host = createFakeChatHost();
            expect(
                await failure(host.chat.setRoomMetadata({ roomId: "x", metadata: { name: "X" } })),
            ).toEqual({
                tag: "Domain",
                value: { tag: "V1", value: { tag: "UnknownRoom" } },
            });
        });

        test("a host-store room refuses writing as the user, duplicates and unknown messages", async () => {
            const host = createFakeChatHost();
            await host.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            const tag = async (update: ChatFeedUpdate) =>
                (
                    (await failure(host.chat.updateFeed({ roomId: "r", update }))) as
                        | { value?: { value?: { tag?: string } } }
                        | undefined
                )?.value?.value?.tag;
            expect(await tag({ tag: "New", value: message("m1", "user") })).toBe("NotOwner");
            expect(await tag({ tag: "New", value: message("m1") })).toBeUndefined();
            expect(await tag({ tag: "New", value: message("m1") })).toBe("DuplicateMessage");
            expect(
                await tag({ tag: "StatusChanged", value: { messageId: "m2", status: "Read" } }),
            ).toBe("UnknownMessage");
            expect(
                await tag({
                    tag: "New",
                    value: message("m3", "product", text("x".repeat(16 * 1024 + 1))),
                }),
            ).toBe("MessageTooLarge");
        });

        test("post_message is refused in a product-source room", async () => {
            const host = createFakeChatHost();
            await host.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            await host.chat.setRoomConfig({
                roomId: "r",
                config: { productSource: true, reactionDetails: false, reportSeen: false },
            });
            expect(
                await failure(
                    host.chat.postMessage({
                        roomId: "r",
                        payload: { tag: "Text", value: { text: "x" } },
                    }),
                ),
            ).toBeDefined();
        });

        test("update_feed is held to 20 a second per room", async () => {
            const clock = new ManualClock(0);
            const host = createFakeChatHost({ clock });
            await host.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            await host.chat.setRoomConfig({
                roomId: "r",
                config: { productSource: true, reactionDetails: false, reportSeen: false },
            });
            const update: ChatFeedUpdate = {
                tag: "StatusChanged",
                value: { messageId: "m", status: "Sent" },
            };
            for (let index = 0; index < 20; index++)
                expect((await host.chat.updateFeed({ roomId: "r", update })).isOk()).toBe(true);
            expect((await host.chat.updateFeed({ roomId: "r", update })).isOk()).toBe(false);
            await clock.advance(1000);
            expect((await host.chat.updateFeed({ roomId: "r", update })).isOk()).toBe(true);
        });

        test("contact rooms are the person chat product's", async () => {
            const contact: ChatRoomContact = {
                account: `0x${"11".repeat(32)}`,
                state: "Established",
            };
            const other = createFakeChatHost({ capabilities: ["contact_rooms"] });
            await other.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            expect(await failure(other.chat.setRoomContact({ roomId: "r", contact }))).toEqual({
                tag: "Domain",
                value: {
                    tag: "V1",
                    value: {
                        tag: "Unknown",
                        value: { reason: "this host does not serve contact_rooms" },
                    },
                },
            });
            const person = createFakeChatHost({ personChatProduct: true });
            await person.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            expect((await person.chat.setRoomContact({ roomId: "r", contact })).isOk()).toBe(true);
        });
    });

    describe("queries", () => {
        test("openRoom asks the newest page, and a missing flag is answered by the core", async () => {
            const host = createFakeChatHost();
            const asked: unknown[] = [];
            host.chat.onMessagesQuery((request, send) => {
                asked.push(request);
                send({ messages: [message("m1")] });
            });
            host.chat.onReactionsQuery(() => {
                throw new Error("must not be asked");
            });
            await host.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            await host.chat.setRoomConfig({
                roomId: "r",
                config: { productSource: true, reactionDetails: false, reportSeen: false },
            });
            expect(await host.openRoom("r", 30)).toEqual({
                ok: true,
                value: { messages: [message("m1")] },
            });
            expect(asked).toEqual([
                { roomId: "r", anchor: { tag: "Before", value: {} }, pageSize: 30 },
            ]);
            expect((await host.reactions("r", "m1")).ok).toBe(false);
        });

        test("userSends gives the product a host-chosen id", async () => {
            const host = createFakeChatHost();
            let action: ChatUserAction | undefined;
            host.chat.onUserAction((request, send) => {
                action = request.action;
                send({ tag: "Acknowledged" });
            });
            await host.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            await host.chat.setRoomConfig({
                roomId: "r",
                config: { productSource: true, reactionDetails: false, reportSeen: false },
            });
            await host.userSends("r", text("hello"));
            expect(action?.tag === "NewMessage" && action.value.messageId).toMatch(
                /^[0-9a-f-]{36}$/,
            );
        });

        test("an answer over its bound is refused", async () => {
            const host = createFakeChatHost();
            host.chat.onMessagesQuery((_request, send) =>
                send({ messages: [message("a"), message("b")] }),
            );
            await host.chat.createRoom({ roomId: "r", name: "R", icon: "" });
            await host.chat.setRoomConfig({
                roomId: "r",
                config: { productSource: true, reactionDetails: false, reportSeen: false },
            });
            expect((await host.openRoom("r", 1)).ok).toBe(false);
        });

        test("room events wait for a subscriber and a second subscription replaces the first", async () => {
            const host = createFakeChatHost();
            host.emitRoomEvent("r", { tag: "CallEnded", value: { callId: "c" } });
            const first: unknown[] = [];
            let firstDone = false;
            host.chat.roomEventsSubscribe().subscribe({
                next: (item) => first.push(item),
                complete: () => {
                    firstDone = true;
                },
            });
            await Promise.resolve();
            expect(first).toHaveLength(1);
            host.chat.roomEventsSubscribe().subscribe({});
            expect(firstDone).toBe(true);
        });

        test("call media starts only after the user's consent in the room", async () => {
            const clock = new ManualClock(0);
            const host = createFakeChatHost({ clock });
            const start = { roomId: "r", callId: "c", video: false, offerer: true };
            expect((await host.callMedia.start(start)).isOk()).toBe(false);
            host.emitRoomEvent("r", { tag: "CallRequested", value: { video: false, callId: "c" } });
            expect((await host.callMedia.start(start)).isOk()).toBe(true);
            await clock.advance(CALL_CONSENT_MS + 1);
            expect((await host.callMedia.start(start)).isOk()).toBe(false);
        });

        test("omit plays an older host", () => {
            const host = createFakeChatHost({ omit: ["updateFeed", "onMessagesQuery"] });
            expect("updateFeed" in host.chat).toBe(false);
            expect(typeof host.chat.createRoom).toBe("function");
        });
    });
}
