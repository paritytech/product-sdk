# Chat room demo

A worker that is a chat product: the host draws its rooms through Chat Extension v2, and the product serves them with
`@parity/product-sdk-chat`.

- **Echo** is a product-source room kept in host storage (`JournaledRoomMessageStore`, scoped to the signed-in
  identity with `sessionScope`). A bot answers each message by streaming its reply: posted as `Preparing`, edited as it
  is written, then `Sent`, with the room's notification.
- **Rooms by link**: opening `demo:room:<name>` from an entry point of the host creates a room of that name and shows
  it (`openLinks`).
- **Announcements** is a host-store room of the first Chat surface, with no input (`getChatManager`).

```bash
pnpm --filter @parity/product-sdk-chat-room-demo test    # the demo on the chat host double
pnpm --filter @parity/product-sdk-chat-room-demo build   # dist/worker.js, checked for ASCII and worker globals
```

`src/demo.ts` takes the client and the store, so `src/demo.test.ts` drives it with `createChatTestbed()` the way a
host screen would: it opens the room, sends a message, and reads the bot's streamed reply.
