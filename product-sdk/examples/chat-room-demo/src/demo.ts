// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A small chat product, put together from `@parity/product-sdk-chat`.
 *
 * - **The echo room** is a product-source room: its messages live in the
 *   product's store, and the host asks for pages as the user scrolls. A bot
 *   answers each message by streaming its reply: posted as `Preparing`, edited
 *   as it is written, then `Sent`, with the room's notification.
 * - **Rooms opened by link**: the host gives the product what the user opened
 *   (`demo:room:<name>`), and the product creates a room of that name and shows
 *   it.
 * - **The announcements room** is a host-store room of the first Chat surface:
 *   the host keeps its messages and the product posts into it.
 *
 * `startDemo` takes the client, the store and the clock, so the tests run it on
 * the chat host double; `worker.ts` runs it in a host.
 */
import {
    FeedSender,
    PreviewScheduler,
    RoomDeclarations,
    type RoomMessageStore,
    type StartedChat,
    StoredRoom,
    type StoredMessage,
    bodyText,
    createChatRooms,
    openLinks,
    text,
} from "@parity/product-sdk-chat";
import type { NotificationManager, TruApi } from "@parity/product-sdk-host";
import { type Clock, systemClock, uuidSource } from "@parity/product-sdk-utils";

/** Where the demo keeps its state. */
export interface DemoContext {
    client: TruApi;
    store: RoomMessageStore;
    notifications?: Pick<NotificationManager, "pushRoom">;
    clock?: Clock;
}

const ECHO_ROOM = "echo";
const PRODUCT_SOURCE = { productSource: true, reactionDetails: true, reportSeen: true };

/** Writes `reply` into `room` a word at a time, as a model streaming an answer would. */
async function streamReply(room: StoredRoom, reply: string, clock: Clock): Promise<void> {
    const messageId = uuidSource.next();
    await room.post({ messageId, body: text(""), status: "Preparing" });
    let written = "";
    for (const word of reply.split(" ")) {
        written = written ? `${written} ${word}` : word;
        await clock.sleep(50);
        await room.edit(messageId, text(written));
    }
    await room.setStatus(messageId, "Sent");
}

/** Starts the demo: declares its rooms and returns how it serves them. */
export async function startDemo(context: DemoContext): Promise<StartedChat> {
    const clock = context.clock ?? systemClock;
    const rooms = createChatRooms(context.client);
    const declarations = new RoomDeclarations(rooms);
    const feed = new FeedSender(rooms, { clock });
    const previews = new PreviewScheduler(rooms, { clock });
    const served = new Map<string, StoredRoom>();

    const openRoom = async (roomId: string, name: string): Promise<StoredRoom> => {
        const known = served.get(roomId);
        if (known) return known;
        const declared = await declarations.declare(roomId, {
            name,
            config: PRODUCT_SOURCE,
            metadata: { name, description: "Write anything: the bot answers." },
        });
        if (!declared.ok) throw declared.error;
        const room: StoredRoom = new StoredRoom({
            roomId,
            store: context.store,
            feed,
            previews,
            clock,
            ...(context.notifications ? { notifications: context.notifications } : {}),
            onUserMessage: async (message: StoredMessage) => {
                const said = bodyText(message.body) ?? "that";
                // Not awaited: the user's message is answered at once, the reply follows.
                void streamReply(room, `You said: ${said}`, clock);
            },
        });
        served.set(roomId, room);
        return room;
    };

    const echo = await openRoom(ECHO_ROOM, "Echo");
    if ((await context.store.messages(ECHO_ROOM, { limit: 1 })).length === 0)
        await echo.post({ messageId: "welcome", body: text("Hello! Write something.") }, { notify: true });

    // A host-store room: no configuration, so the host keeps its messages; no input, so only the product writes.
    const announcements = await rooms.createRoom({ roomId: "announcements", name: "Announcements", icon: "" });
    if (announcements.ok && announcements.value === "New") {
        await rooms.setFooter("announcements", "Empty");
        await rooms.postMessage("announcements", { tag: "Text", value: { text: "The demo is running." } });
    }

    const links = openLinks().on("demo:room:", async (name) => {
        const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (!clean) return {};
        const room = await openRoom(`room-${clean}`, name.trim());
        return { roomId: room.roomId };
    });

    return {
        resolve: (roomId) => served.get(roomId),
        openLink: links.handle,
        stop: async () => {
            await feed.flushed();
            await previews.flushed();
        },
    };
}
