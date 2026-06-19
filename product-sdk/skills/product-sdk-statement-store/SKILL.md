---
name: product-sdk-statement-store
description: >
  Use when publishing or subscribing to ephemeral messages on the Polkadot Statement Store.
  Covers StatementStoreClient lifecycle, two connection modes (host and local), topic/channel
  creation, ChannelStore last-write-wins semantics, data size limits, and StatementTransport BYOD.
---

# Product SDK Statement Store

The Statement Store is a pub/sub messaging system built on top of the Polkadot Bulletin Chain. It lets peers publish small, signed, ephemeral statements tagged with topics and optional channels.

Package: `@parity/product-sdk-statement-store`

> **DATA SIZE LIMIT: MAX_STATEMENT_SIZE = 512 bytes.** The JSON-serialized payload must not exceed 512 bytes after UTF-8 encoding.

> **TWO CONNECTION MODES.** Use `{ mode: "host", accountId }` inside containers or `{ mode: "local", signer }` outside containers.

## Quick Start: Host Mode (Inside Container)

```ts
import { StatementStoreClient } from "@parity/product-sdk-statement-store";

const client = new StatementStoreClient({ appName: "my-app" });

await client.connect({ mode: "host", accountId: ["5Grw...", 42] });

const sub = client.subscribe<{ type: string }>(statement => {
  console.log(statement.data.type);
});

await client.publish({ type: "presence" }, { channel: "room-42" });

sub.unsubscribe();
client.destroy();
```

## Quick Start: Local Mode (Outside Container)

```ts
import { StatementStoreClient } from "@parity/product-sdk-statement-store";

const client = new StatementStoreClient({
  appName: "my-app",
});

await client.connect({
  mode: "local",
  signer: { publicKey: myPublicKey, sign: (msg) => sr25519Sign(msg, mySecretKey) },
});

const sub = client.subscribe<{ type: string }>(statement => {
  console.log(statement.data.type);
});

await client.publish({ type: "presence" });

sub.unsubscribe();
client.destroy();
```

## StatementStoreClient Lifecycle

### Create

```ts
const client = new StatementStoreClient({
  appName: "my-app",               // required: hashed as topic1
  defaultTtlSeconds: 30,           // optional: statement TTL (default 30)
  // transport: customTransport,   // optional: BYOD transport for tests
});
```

### Connect

```ts
// Host mode
await client.connect({ mode: "host", accountId: ["5Grw...", 42] });

// Local mode
await client.connect({ mode: "local", signer: { publicKey, sign } });
```

### Publish

```ts
const accepted = await client.publish<MyData>(data, {
  channel: "my-channel",
  topic2: "room-id",
});
```

### Subscribe

```ts
const sub = client.subscribe<MyData>(callback, { topic2: "room-id" });
sub.unsubscribe();
```

### Destroy

```ts
client.destroy();
```

## ChannelStore: Last-Write-Wins

```ts
import { ChannelStore } from "@parity/product-sdk-statement-store";

const channels = new ChannelStore<Presence>(client, { topic2: "doc-123" });

await channels.write("presence/peer-abc", { type: "presence", timestamp: Date.now() });
const value = channels.read("presence/peer-abc");
const all = channels.readAll();

const sub = channels.onChange((channelName, value, previous) => {
  console.log(`${channelName} updated`);
});

channels.destroy();
```

## Topics and Channels

```ts
import { createTopic, createChannel, topicToHex } from "@parity/product-sdk-statement-store";

const topic = createTopic("my-room");
const channel = createChannel("presence/peer-abc");
const hex = topicToHex(topic);
```

## Error Handling

```ts
import {
  StatementStoreError,
  StatementConnectionError,
  StatementDataTooLargeError,
} from "@parity/product-sdk-statement-store";
```

## Common Mistakes

1. **Exceeding 512-byte data limit** - Use for signaling, not bulk data
2. **Using `PolkadotSigner` instead of `StatementSignerWithKey`** - Different interface
3. **Using host mode outside a container** - Host API only available inside containers
4. **Forgetting to call `destroy()`** - Keeps connections open
5. **Not awaiting `connect()`** - Must connect before publish/subscribe

## Reference Files

- [statement-store-api.md](references/statement-store-api.md) - Full API surface
