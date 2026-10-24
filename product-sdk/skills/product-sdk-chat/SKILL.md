---
name: product-sdk-chat
description: >
  Build a chat product whose rooms the host draws through Chat Extension v2.
  Use when: a product serves chat rooms (a bot, a support desk, a bridge to a backend, a group chat), declares a
  room's configuration, metadata, preview or footer, pushes feed updates, answers messages_query, user_action,
  reactions_query, search_query, edit_history or open_link, keeps a room's messages in host storage, streams a long
  answer, runs calls with the host's call engine, sends a room notification, or tests any of this.
  Covers @parity/product-sdk-chat (RoomDeclarations, FeedSender, PreviewScheduler, builders, page, searchPage,
  serveRooms, userActions, StoredRoom, JournaledRoomMessageStore, RoomCalls, openLinks, defineChatWorker,
  ROOM_LIMITS, /testing createChatTestbed), the chat bindings of @parity/product-sdk-host (getChatRooms,
  serveChatQueries, getCallMedia, ChatRoomError, FeatureUnavailableError) and, for the person-to-person protocol,
  @parity/product-sdk-chat-protocol.
---

# Chat products

Through Chat Extension v2 a product's **worker** owns the data of its rooms and the **host** draws them with native
elements. Import everything from `@parity/product-sdk-chat` (it re-exports the host bindings and every Chat Extension v2
type); tests use `@parity/product-sdk-chat/testing`. Worked example: `examples/chat-room-demo/`.

## The shape of the whole thing

1. The worker manifest declares chat: `{ "kind": "worker", "includes": { "chat": true }, ... }`.
2. `defineChatWorker({ start })` at the **top level of the worker, before any `await`**. It registers every host query
   handler (the client buffers only 64 starts per stream until one exists) and answers "unavailable" until `start`
   resolves; the host asks again once after a second.
3. In `start`, declare rooms with `RoomDeclarations` and return `{ resolve(roomId) => RoomSource | undefined }`.
4. Serve each product-source room with a `StoredRoom` (messages in a `RoomMessageStore`) or your own `RoomSource`.

```ts
defineChatWorker({
    async start({ client }) {
        const rooms = createChatRooms(client);
        const feed = new FeedSender(rooms);
        const previews = new PreviewScheduler(rooms);
        await new RoomDeclarations(rooms).declare("support", {
            name: "Support",
            config: { productSource: true, reactionDetails: true, reportSeen: true },
        });
        const room = new StoredRoom({ roomId: "support", store, feed, previews, onUserMessage: send });
        return { resolve: (roomId) => (roomId === "support" ? room : undefined) };
    },
});
```

## Rules that bite

- **Room kinds.** Without a configuration a room is host-store: the host keeps messages, `postMessage` posts, user
  messages arrive on `action_subscribe`. With `productSource: true` the product keeps them and must answer
  `messages_query`; `postMessage` is refused there.
- **Declarations persist.** The host keeps every declaration; `create_room` on an existing room answers `Exists`
  and keeps them. Declare the configuration right after creating a room. `RoomDeclarations` sends only what changed.
- **Rates.** `update_feed` 20/s, `set_room_preview` 5/s, `set_room_call` 2/s, `set_room_contact` 5/s per room. Push
  through `FeedSender` and `PreviewScheduler`, never `rooms.updateFeed` in a loop.
- **Bounds.** Identifiers 256 bytes, display text 256 bytes, message text 16 KiB, 32 media, 64 reaction summaries,
  page size 1 to 100, search 1 to 50, cursors 1 KiB. `checkMessage` finds out before the host refuses.
- **Host-chosen ids.** `NewMessage` and `SendPayment` may carry the host's message id and come again after a time-out:
  answer with what was stored the first time (`userActions({ existing })` does).
- **Refusals.** Room calls return `Result`. `ChatRoomError.failure.tag` is the host's answer (`RateLimited`,
  `NotOwner`, `UnknownMessage`, ...). `FeatureUnavailableError.feature` names what the host does not serve.
- **Query handlers throw** `UnknownRoomError`, `UnknownMessageError`, `NotAvailableError` or
  `UserActionRejectedError` (its message is shown to the user); anything else is answered `Unknown`.
- **The person chat's features.** Contact rooms (`setContact`, contact states and actions), HOP media
  (`ChatResource::Hop`, `hop_attachments`) and `PersonChat` are served to the `chat` product only. A third-party chat
  has no media today.
- **Untrusted links.** An `open_link` payload comes from anyone; ask the user before an effect they did not ask for.
- **Streaming.** `New` with `Preparing`, `Edited` as text arrives, `StatusChanged` to `Sent`: `streamMessage`, or
  `StoredRoom.post` with `status: "Preparing"` then `edit` and `setStatus`.
- **Waking.** No scheduled wakeups. A message in flight, a chat push (12 per hour) or the first start hold the
  worker 30 s; longer work runs in `holdWorker(label).around(...)`.

## Calls

`RoomCalls` runs one call at a time over your own `CallSignalling` (ring, accept, signal, close). Default flow
(`offers: "answerer"`): the side that accepts makes the media offer. Call media starts only within 180 s of the
user's press or acceptance. Feed it `rooms.subscribeRoomEvents(...)`.

## Testing

```ts
const { host, client, rooms, clock } = createChatTestbed();
serveRoomsOn(client, { resolve });
await host.openRoom("support");
await host.userSends("support", text("hi"), { messageId: "u1" });
await settle();
await clock.advance(1_000);
expect(host.room("support").feed.map((update) => update.tag)).toEqual(["New", "Edited"]);
```

The double enforces the core's rules, bounds and rates. Settle before advancing the manual clock.

See [`references/protocol.md`](references/protocol.md) for the person-to-person protocol package.
