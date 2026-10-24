// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Routing the host's questions to the room they are about.
 *
 * A product serves each of its product-source rooms through a {@link RoomSource}:
 * its pages, the user's actions in it, who reacted, its search and edit history.
 * {@link serveRooms} answers every host query by finding the source of the query's
 * room. A room without a source is `UnknownRoom`; a question a source does not
 * answer gets the RFC's default (`NotAvailable`, or `Rejected` for an action).
 *
 * @module
 */
import {
    type ChatMessageRevision,
    type ChatPageAnchor,
    type ChatQueryHandlers,
    type ChatQueryRegistration,
    type ChatReactionDetail,
    type ChatUserAction,
    NotAvailableError,
    type ProductChatMessagesQueryItem,
    type ProductChatOpenLinkItem,
    type ProductChatOpenLinkRequest,
    type ProductChatSearchQueryItem,
    type ProductChatUserActionItem,
    type TruApi,
    UnknownRoomError,
    UserActionRejectedError,
    serveChatQueries,
    serveChatQueriesOn,
} from "@parity/product-sdk-host";

/** What a product serves for one product-source room. Only `messages` is required. */
export interface RoomSource {
    /** One page, oldest first, with the cursor of the next page in the same direction. See `page`. */
    messages(anchor: ChatPageAnchor, pageSize: number): Promise<ProductChatMessagesQueryItem>;
    /** Something the user did in the room. See `userActions`. Without it every action is `Rejected`. */
    userAction?(action: ChatUserAction): Promise<ProductChatUserActionItem>;
    /** Who reacted to a message. Asked only when the room's configuration sets `reactionDetails`. */
    reactions?(messageId: string): Promise<ChatReactionDetail[]>;
    /** Messages matching what the user typed, newest first. See `searchPage`. */
    search?(
        text: string,
        cursor: string | undefined,
        pageSize: number,
    ): Promise<ProductChatSearchQueryItem>;
    /** The texts a message had, oldest first. See `editHistory`. */
    editHistory?(messageId: string): Promise<ChatMessageRevision[]>;
}

/** How {@link serveRooms} finds a room's source. */
export interface RoomRoutes {
    /** The source of a room, or `undefined` for a room the product does not serve. */
    resolve(roomId: string): RoomSource | undefined | Promise<RoomSource | undefined>;
    /** What the user opened from an entry point of the host. See `openLinks`. */
    openLink?(request: ProductChatOpenLinkRequest): Promise<ProductChatOpenLinkItem>;
}

/** The {@link ChatQueryHandlers} that answer from `routes`. */
export function roomQueryHandlers(routes: RoomRoutes): ChatQueryHandlers {
    const source = async (roomId: string): Promise<RoomSource> => {
        const found = await routes.resolve(roomId);
        if (!found) throw new UnknownRoomError(roomId);
        return found;
    };
    return {
        async messages({ roomId, anchor, pageSize }) {
            return (await source(roomId)).messages(anchor, pageSize);
        },
        async userAction({ roomId, action }) {
            const room = await source(roomId);
            if (!room.userAction) throw new UserActionRejectedError("This room takes no actions");
            return room.userAction(action);
        },
        async reactions({ roomId, messageId }) {
            const room = await source(roomId);
            if (!room.reactions) throw new NotAvailableError();
            return { reactions: await room.reactions(messageId) };
        },
        async search({ roomId, text, cursor, pageSize }) {
            const room = await source(roomId);
            if (!room.search) throw new NotAvailableError();
            return room.search(text, cursor, pageSize);
        },
        async editHistory({ roomId, messageId }) {
            const room = await source(roomId);
            if (!room.editHistory) throw new NotAvailableError();
            return { revisions: await room.editHistory(messageId) };
        },
        ...(routes.openLink
            ? {
                  openLink: (request) =>
                      (routes.openLink as NonNullable<RoomRoutes["openLink"]>)(request),
              }
            : {}),
    };
}

/**
 * Answers every host query from `routes`, or returns `null` outside a container.
 * Call it at the top level of the worker, before the first `await`. While `routes`
 * returns `undefined` the product is still starting, and each query is answered
 * "unavailable", which the host asks again once.
 *
 * @example
 * ```ts
 * let rooms: Map<string, RoomSource> | undefined;
 * serveRooms(() => rooms && { resolve: (roomId) => rooms?.get(roomId) });
 * rooms = await openRooms();
 * ```
 */
export function serveRooms(
    routes: RoomRoutes | (() => RoomRoutes | undefined),
): ChatQueryRegistration | null {
    return serveChatQueries(handlersOf(routes));
}

/** {@link serveRooms} on a given client. */
export function serveRoomsOn(
    client: TruApi,
    routes: RoomRoutes | (() => RoomRoutes | undefined),
): ChatQueryRegistration {
    return serveChatQueriesOn(client, handlersOf(routes));
}

function handlersOf(routes: RoomRoutes | (() => RoomRoutes | undefined)) {
    if (typeof routes !== "function") return roomQueryHandlers(routes);
    let last: { routes: RoomRoutes; handlers: ChatQueryHandlers } | undefined;
    return () => {
        const current = routes();
        if (!current) return undefined;
        if (last?.routes !== current)
            last = { routes: current, handlers: roomQueryHandlers(current) };
        return last.handlers;
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { createFakeChatHost, createFakeTruApiClient } = await import(
        "@parity/product-sdk-host/testing"
    );
    const { createChatRooms } = await import("@parity/product-sdk-host");

    async function setup(routes: () => RoomRoutes | undefined) {
        const host = createFakeChatHost();
        const client = createFakeTruApiClient({ chatHost: host });
        serveRoomsOn(client, routes);
        const rooms = createChatRooms(client);
        await rooms.createRoom({ roomId: "r", name: "R", icon: "" });
        await rooms.setConfig("r", {
            productSource: true,
            reactionDetails: true,
            reportSeen: true,
        });
        return host;
    }

    const empty: RoomSource = { messages: async () => ({ messages: [] }) };

    test("a query reaches the source of its room", async () => {
        const host = await setup(() => ({
            resolve: (roomId) => (roomId === "r" ? empty : undefined),
        }));
        expect(await host.openRoom("r")).toEqual({ ok: true, value: { messages: [] } });
    });

    test("a room without a source is UnknownRoom", async () => {
        const host = await setup(() => ({ resolve: () => undefined }));
        expect(await host.openRoom("r")).toEqual({
            ok: false,
            reason: { tag: "Domain", value: { tag: "V1", value: { tag: "UnknownRoom" } } },
        });
    });

    test("questions a source does not answer get the RFC's defaults", async () => {
        const host = await setup(() => ({ resolve: () => empty }));
        expect((await host.reactions("r", "m")).ok).toBe(false);
        const action = await host.userSends("r", { tag: "Text", value: { text: "hi" } });
        expect(action).toEqual({
            ok: false,
            reason: {
                tag: "Domain",
                value: {
                    tag: "V1",
                    value: { tag: "Rejected", value: { reason: "This room takes no actions" } },
                },
            },
        });
    });

    test("while starting, queries are answered unavailable", async () => {
        const host = await setup(() => undefined);
        expect(await host.openRoom("r")).toEqual({
            ok: false,
            reason: { tag: "HostFailure", value: { reason: "unavailable" } },
        });
    });
}
