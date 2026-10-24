// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The host's questions to a chat product, answered with promises.
 *
 * Chat Extension v2 has the host ask the product through host-initiated queries:
 * a page of messages, a user action in a product-source room, who reacted, a
 * search, the edit history of a message, and what the user opened from an entry
 * point of the host. Each query gets one answer, then completes.
 *
 * `serveChatQueries` registers a handler for every one of them. Call it at the top
 * level of the worker, before the first `await`: the client buffers at most 64
 * starts per stream until a handler is registered, and the host delivers a start
 * only after the bundle's top-level evaluation, so a handler registered then never
 * misses a query.
 *
 * @module
 */
import type {
    HostInitiatedSubscriptionHandler,
    ProductChatEditHistoryQueryItem,
    ProductChatEditHistoryQueryRequest,
    ProductChatMessagesQueryItem,
    ProductChatMessagesQueryRequest,
    ProductChatOpenLinkItem,
    ProductChatOpenLinkRequest,
    ProductChatQueryError,
    ProductChatReactionsQueryItem,
    ProductChatReactionsQueryRequest,
    ProductChatSearchQueryItem,
    ProductChatSearchQueryRequest,
    ProductChatUserActionError,
    ProductChatUserActionItem,
    ProductChatUserActionRequest,
    TrUApiClient,
    VersionedProductChatQueryError,
    VersionedProductChatUserActionError,
    scale,
} from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import {
    NotAvailableError,
    UnknownMessageError,
    UnknownRoomError,
    UserActionRejectedError,
} from "./chat-errors.js";
import { getClientSync } from "./transport.js";

const log = createLogger("host:chat");

/**
 * What a product answers. Every handler is optional: a query without one is
 * answered the way the RFC answers a product that does not serve it.
 *
 * A handler resolves its answer, or throws {@link UnknownRoomError},
 * {@link UnknownMessageError}, {@link NotAvailableError} or
 * {@link UserActionRejectedError} to give the matching refusal. Anything else it
 * throws is answered `Unknown` and logged.
 */
export interface ChatQueryHandlers {
    /** A page of messages of a product-source room. Without it: `NotAvailable`. */
    messages?(request: ProductChatMessagesQueryRequest): Promise<ProductChatMessagesQueryItem>;
    /** A user action in a product-source room. Without it: `Rejected`. */
    userAction?(request: ProductChatUserActionRequest): Promise<ProductChatUserActionItem>;
    /** Who reacted to a message. Without it: `NotAvailable`. */
    reactions?(request: ProductChatReactionsQueryRequest): Promise<ProductChatReactionsQueryItem>;
    /** Messages matching what the user typed, newest first. Without it: `NotAvailable`. */
    search?(request: ProductChatSearchQueryRequest): Promise<ProductChatSearchQueryItem>;
    /** The texts a message had, oldest first. Without it: `NotAvailable`. */
    editHistory?(
        request: ProductChatEditHistoryQueryRequest,
    ): Promise<ProductChatEditHistoryQueryItem>;
    /** What the user opened. The payload is untrusted input. Without it: `Unsupported`. */
    openLink?(request: ProductChatOpenLinkRequest): Promise<ProductChatOpenLinkItem>;
}

/** Stops answering the host's queries. */
export interface ChatQueryRegistration {
    unsubscribe(): void;
}

type QueryReason = scale.CallErrorValue<VersionedProductChatQueryError>;
type ActionReason = scale.CallErrorValue<VersionedProductChatUserActionError>;

/**
 * The answer the host treats as "unavailable": it asks once more after a second,
 * then applies its default. A product answers so while it is still starting.
 */
const STARTING = { tag: "HostFailure", value: { reason: "unavailable" } } as const;

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function queryReason(error: unknown): QueryReason {
    const failure: ProductChatQueryError =
        error instanceof UnknownRoomError
            ? { tag: "UnknownRoom" }
            : error instanceof NotAvailableError
              ? { tag: "NotAvailable" }
              : { tag: "Unknown", value: { reason: reasonOf(error) } };
    return { tag: "Domain", value: { tag: "V1", value: failure } };
}

function actionReason(error: unknown): ActionReason {
    const failure: ProductChatUserActionError =
        error instanceof UnknownRoomError
            ? { tag: "UnknownRoom" }
            : error instanceof UnknownMessageError
              ? { tag: "UnknownMessage" }
              : error instanceof UserActionRejectedError
                ? { tag: "Rejected", value: { reason: error.message } }
                : { tag: "Unknown", value: { reason: reasonOf(error) } };
    return { tag: "Domain", value: { tag: "V1", value: failure } };
}

/** Whether an error is one of the refusals a handler throws on purpose. */
function isRefusal(error: unknown): boolean {
    return (
        error instanceof UnknownRoomError ||
        error instanceof UnknownMessageError ||
        error instanceof NotAvailableError ||
        error instanceof UserActionRejectedError
    );
}

function serve<Request, Item, Reason>(
    name: string,
    resolve: () => ChatQueryHandlers | undefined,
    pick: (handlers: ChatQueryHandlers) => ((request: Request) => Promise<Item>) | undefined,
    missing: Reason,
    toReason: (error: unknown) => Reason,
): HostInitiatedSubscriptionHandler<Request, Item, Reason> {
    return (request, send, interrupt) => {
        const handlers = resolve();
        if (!handlers) {
            interrupt(STARTING as Reason);
            return;
        }
        const handler = pick(handlers);
        if (!handler) {
            interrupt(missing);
            return;
        }
        let stopped = false;
        Promise.resolve()
            .then(() => handler.call(handlers, request))
            .then(
                (item) => {
                    if (!stopped) send(item);
                },
                (error: unknown) => {
                    if (!isRefusal(error)) log.warn(`${name} failed`, { reason: reasonOf(error) });
                    if (!stopped) interrupt(toReason(error));
                },
            );
        return () => {
            stopped = true;
        };
    };
}

/**
 * Answers the host's chat queries from `handlers` on `client`. `handlers` may be a
 * function, read at each query: while it returns `undefined` (the product is still
 * starting) every query is answered "unavailable", which the host asks again once
 * after a second.
 *
 * Calling it again replaces the previous handlers.
 */
export function serveChatQueriesOn(
    client: TrUApiClient,
    handlers: ChatQueryHandlers | (() => ChatQueryHandlers | undefined),
): ChatQueryRegistration {
    const resolve = typeof handlers === "function" ? handlers : () => handlers;
    const chat = client.chat as Partial<TrUApiClient["chat"]>;
    const registrations: { unsubscribe(): void }[] = [];
    const notAvailable = queryReason(new NotAvailableError());

    if (chat.onMessagesQuery) {
        registrations.push(
            chat.onMessagesQuery(
                serve("messages_query", resolve, (h) => h.messages, notAvailable, queryReason),
            ),
        );
    }
    if (chat.onUserAction) {
        registrations.push(
            chat.onUserAction(
                serve(
                    "user_action",
                    resolve,
                    (h) => h.userAction,
                    actionReason(new UserActionRejectedError("This chat takes no actions")),
                    actionReason,
                ),
            ),
        );
    }
    if (chat.onReactionsQuery) {
        registrations.push(
            chat.onReactionsQuery(
                serve("reactions_query", resolve, (h) => h.reactions, notAvailable, queryReason),
            ),
        );
    }
    if (chat.onSearchQuery) {
        registrations.push(
            chat.onSearchQuery(
                serve("search_query", resolve, (h) => h.search, notAvailable, queryReason),
            ),
        );
    }
    if (chat.onEditHistory) {
        registrations.push(
            chat.onEditHistory(
                serve("edit_history", resolve, (h) => h.editHistory, notAvailable, queryReason),
            ),
        );
    }
    if (chat.onOpenLink) {
        registrations.push(
            chat.onOpenLink(
                serve(
                    "open_link",
                    resolve,
                    (h) => h.openLink,
                    { tag: "Unsupported" } as QueryReason,
                    queryReason,
                ),
            ),
        );
    }
    return {
        unsubscribe() {
            for (const registration of registrations.splice(0)) registration.unsubscribe();
        },
    };
}

/**
 * Answers the host's chat queries from `handlers`, or returns `null` outside a host
 * container. Synchronous on purpose: call it at the top level of the worker.
 *
 * @example
 * ```ts
 * import { serveChatQueries, UnknownRoomError } from "@parity/product-sdk-host";
 *
 * let rooms: Map<string, MyRoom> | undefined;
 * serveChatQueries(() =>
 *     rooms && {
 *         async messages({ roomId, anchor, pageSize }) {
 *             const room = rooms?.get(roomId);
 *             if (!room) throw new UnknownRoomError(roomId);
 *             return room.page(anchor, pageSize);
 *         },
 *     },
 * );
 * rooms = await openRooms(); // queries before this point are answered "unavailable"
 * ```
 */
export function serveChatQueries(
    handlers: ChatQueryHandlers | (() => ChatQueryHandlers | undefined),
): ChatQueryRegistration | null {
    const client = getClientSync();
    return client ? serveChatQueriesOn(client, handlers) : null;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    type AnyHandler = HostInitiatedSubscriptionHandler<unknown, unknown, unknown>;

    function fakeClient() {
        const handlers = new Map<string, AnyHandler>();
        const register = (name: string) => (handler: AnyHandler) => {
            handlers.set(name, handler);
            return { unsubscribe: () => handlers.delete(name) };
        };
        const client = {
            chat: {
                onMessagesQuery: register("messages"),
                onUserAction: register("userAction"),
                onReactionsQuery: register("reactions"),
                onSearchQuery: register("search"),
                onEditHistory: register("editHistory"),
                onOpenLink: register("openLink"),
            },
        } as unknown as TrUApiClient;
        const ask = (name: string, request: unknown) =>
            new Promise<{ item?: unknown; reason?: unknown }>((resolve) => {
                const handler = handlers.get(name);
                if (!handler) throw new Error(`no ${name} handler`);
                handler(
                    request,
                    (item) => resolve({ item }),
                    (reason) => resolve({ reason }),
                );
            });
        return { client, ask, handlers };
    }

    const request = { roomId: "r", anchor: { tag: "Before", value: {} }, pageSize: 10 };

    describe("serveChatQueriesOn", () => {
        test("a handler's answer is sent", async () => {
            const { client, ask } = fakeClient();
            serveChatQueriesOn(client, { messages: async () => ({ messages: [] }) });
            expect(await ask("messages", request)).toEqual({ item: { messages: [] } });
        });

        test("while the product starts, every query is answered unavailable", async () => {
            const { client, ask } = fakeClient();
            serveChatQueriesOn(client, () => undefined);
            expect(await ask("messages", request)).toEqual({ reason: STARTING });
            expect(await ask("userAction", { roomId: "r", action: { tag: "Seen" } })).toEqual({
                reason: STARTING,
            });
        });

        test("a missing handler gets the RFC's answer", async () => {
            const { client, ask } = fakeClient();
            serveChatQueriesOn(client, {});
            expect(await ask("search", {})).toEqual({
                reason: { tag: "Domain", value: { tag: "V1", value: { tag: "NotAvailable" } } },
            });
            expect(await ask("openLink", {})).toEqual({ reason: { tag: "Unsupported" } });
        });

        test("refusals become domain answers", async () => {
            const { client, ask } = fakeClient();
            serveChatQueriesOn(client, {
                messages: async () => {
                    throw new UnknownRoomError("r");
                },
                userAction: async () => {
                    throw new UserActionRejectedError("Not now");
                },
                reactions: async () => {
                    throw new NotAvailableError();
                },
            });
            expect(await ask("messages", request)).toEqual({
                reason: { tag: "Domain", value: { tag: "V1", value: { tag: "UnknownRoom" } } },
            });
            expect(await ask("userAction", {})).toEqual({
                reason: {
                    tag: "Domain",
                    value: { tag: "V1", value: { tag: "Rejected", value: { reason: "Not now" } } },
                },
            });
            expect(await ask("reactions", {})).toEqual({
                reason: { tag: "Domain", value: { tag: "V1", value: { tag: "NotAvailable" } } },
            });
        });

        test("any other failure is Unknown with its message", async () => {
            const { client, ask } = fakeClient();
            serveChatQueriesOn(client, {
                editHistory: async () => {
                    throw new Error("store closed");
                },
            });
            expect(await ask("editHistory", {})).toEqual({
                reason: {
                    tag: "Domain",
                    value: {
                        tag: "V1",
                        value: { tag: "Unknown", value: { reason: "store closed" } },
                    },
                },
            });
        });

        test("an answer after the host stopped the query is not sent", async () => {
            const { client, handlers } = fakeClient();
            let finish: (value: { messages: [] }) => void = () => {};
            serveChatQueriesOn(client, {
                messages: () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            });
            const send = vi.fn();
            const stop = handlers.get("messages")?.(request, send, vi.fn());
            if (typeof stop === "function") stop();
            finish({ messages: [] });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(send).not.toHaveBeenCalled();
        });

        test("unsubscribe removes every handler", () => {
            const { client, handlers } = fakeClient();
            serveChatQueriesOn(client, {}).unsubscribe();
            expect(handlers.size).toBe(0);
        });

        test("an older client registers only what it has", () => {
            const onMessagesQuery = vi.fn(() => ({ unsubscribe: vi.fn() }));
            serveChatQueriesOn({ chat: { onMessagesQuery } } as unknown as TrUApiClient, {});
            expect(onMessagesQuery).toHaveBeenCalledOnce();
        });
    });

    test("serveChatQueries returns null outside a container", () => {
        expect(serveChatQueries({})).toBeNull();
    });
}
