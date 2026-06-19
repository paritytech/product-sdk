# Statement Store API Reference

Package: `@parity/product-sdk-statement-store`

## StatementStoreClient

```ts
import { StatementStoreClient } from "@parity/product-sdk-statement-store";
```

### Constructor

```ts
constructor(config: StatementStoreConfig)
```

### Methods

```ts
async connect(credentials: ConnectionCredentials): Promise<void>
async publish<T>(data: T, options?: PublishOptions): Promise<boolean>
subscribe<T>(callback: (statement: ReceivedStatement<T>) => void, options?: { topic2?: string }): Unsubscribable
async query<T>(options?: { topic2?: string }): Promise<ReceivedStatement<T>[]>
isConnected(): boolean
getPublicKeyHex(): string
destroy(): void
```

---

## ChannelStore\<T\>

```ts
import { ChannelStore } from "@parity/product-sdk-statement-store";
```

### Constructor

```ts
constructor(client: StatementStoreClient, options?: { topic2?: string })
```

### Methods

```ts
async write(channelName: string, value: T): Promise<boolean>
read(channelName: string): T | undefined
readAll(): ReadonlyMap<string, T>
get size: number
onChange(callback: (channelName: string, value: T, previous: T | undefined) => void): Unsubscribable
destroy(): void
```

---

## Topic Functions

```ts
function createTopic(name: string): TopicHash
function createChannel(name: string): ChannelHash
function topicToHex(hash: Uint8Array): string
function topicsEqual(a: Uint8Array, b: Uint8Array): boolean
```

---

## Data Functions

```ts
function encodeData<T>(value: T): Uint8Array  // Throws if > 512 bytes
function decodeData<T>(bytes: Uint8Array): T
function toHex(bytes: Uint8Array): string
function fromHex(hex: string): Uint8Array
```

---

## Error Classes

- `StatementStoreError` (base)
- `StatementEncodingError`
- `StatementSubmitError`
- `StatementSubscriptionError`
- `StatementConnectionError`
- `StatementDataTooLargeError`

---

## Types

### ConnectionCredentials

```ts
type ConnectionCredentials =
  | { mode: "host"; accountId: [string, number] }
  | { mode: "local"; signer: StatementSignerWithKey };
```

### StatementStoreConfig

```ts
interface StatementStoreConfig {
  appName: string;
  defaultTtlSeconds?: number;
  transport?: StatementTransport;
}
```

### ReceivedStatement\<T\>

```ts
interface ReceivedStatement<T = unknown> {
  data: T;
  signerHex?: string;
  channelHex?: string;
  topics: string[];
  expiry?: bigint;
  raw: Statement;
}
```

### StatementSignerWithKey

```ts
interface StatementSignerWithKey {
  publicKey: Uint8Array;  // 32-byte Sr25519 public key
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}
```

---

## Constants

| Constant | Value |
|----------|-------|
| `MAX_STATEMENT_SIZE` | 512 bytes |
| `MAX_USER_TOTAL` | 1024 bytes |
| `DEFAULT_TTL_SECONDS` | 30 |
| `DEFAULT_POLL_INTERVAL_MS` | 10,000 |
