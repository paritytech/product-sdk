# Cloud Storage API Reference

Package: `@parity/product-sdk-cloud-storage`

## CloudStorageClient Class

### Static Methods

#### `CloudStorageClient.create(options)`

```ts
static async create(options: CreateCloudStorageClientOptions): Promise<CloudStorageClient>
```

Create a client from an environment shorthand (`{ environment, signer }`) or an explicit network (`{ genesisHash, descriptor, signer }`). A `signer` is always required.

#### `CloudStorageClient.from(inner, api)`

```ts
static from(inner: AsyncBulletinClient, api: CloudStorageApi): CloudStorageClient
```

Construct from a pre-built upstream client + typed API. The caller owns the connection lifecycle.

### Instance Methods

#### `client.store(data)`

```ts
store(data: Uint8Array): StoreBuilder
```

Build a store transaction. See [`StoreBuilder`](#storebuilder) for chained options and `send()` / `sendUnsigned()`.

#### `client.authorizeAccount(who, transactions, bytes)`

```ts
authorizeAccount(who: string, transactions: number, bytes: bigint): AuthCallBuilder
```

Authorize an account to store data (sudo required on most networks).

#### `client.authorizePreimage(contentHash, maxSize)`

```ts
authorizePreimage(contentHash: Uint8Array, maxSize: bigint): AuthCallBuilder
```

Authorize content storage by hash (anyone can then store it fee-free via `store(...).sendUnsigned()`).

#### `client.renew(block, index)`

```ts
renew(block: number, index: number): CallBuilder
```

Renew a stored transaction by `(block, index)` (e.g. from a `StoreResult`).

#### `client.estimateAuthorization(dataSize)`

```ts
estimateAuthorization(dataSize: number): { transactions: number; bytes: number }
```

#### `client.fetchBytes(cid, options?)`

```ts
async fetchBytes(cid: string, options?: QueryOptions): Promise<Uint8Array>
```

Container-only -- resolves via the host preimage lookup; **throws `CloudStorageHostUnavailableError` outside a container**.

#### `client.fetchJson<T>(cid, options?)`

```ts
async fetchJson<T>(cid: string, options?: QueryOptions): Promise<T>
```

Container-only -- same semantics as `fetchBytes`.

#### `client.checkAuthorization(address)`

```ts
async checkAuthorization(address: string): Promise<AuthorizationStatus>
```

#### `client.verifyStored(cid, options)`

```ts
async verifyStored(cid: string, options: VerifyStoredOptions): Promise<ChainStoredEntry | null>
```

Confirm a CID was recorded on-chain at a known block (no byte fetch). `options.block` is required.

#### `client.destroy()`

```ts
async destroy(): Promise<void>
```

---

## StoreBuilder

Returned by `client.store(data)` (re-exported from `@parity/bulletin-sdk`). Chainable -- each `with*` returns `this`:

```ts
withCodec(codec: CidCodec | number): this
withHashAlgorithm(algorithm: HashAlgorithm): this
withWaitFor(waitFor: WaitFor): this          // "in_block" | "finalized"
withCallback(callback: ProgressCallback): this
withChunkSize(chunkSize: number): this       // forces the chunked path
withManifest(enabled: boolean): this         // DAG-PB manifest for chunked uploads (default: true)

send(): Promise<StoreResult>                 // signed transaction
sendUnsigned(): Promise<StoreResult>         // for preimage-pre-authorized content (fee-free)
```

---

## Standalone Functions

### `calculateCid(data, cidCodec?, hashAlgorithm?)`

```ts
async function calculateCid(data: Uint8Array, cidCodec?: number, hashAlgorithm?: HashAlgorithm): Promise<CID>
```

Compute a CID without uploading. Async; returns a `CID` object (re-exported from `@parity/bulletin-sdk`).

### `cidToPreimageKey(cid)`

```ts
function cidToPreimageKey(cid: string): `0x${string}`
```

### `hashToCid(hexHash, hashCode?, codec?)`

```ts
function hashToCid(hexHash: `0x${string}`, hashCode?: HashAlgorithm, codec?: CidCodec): string
```

Reconstruct a CID string from an on-chain hex hash.

### `queryBytes(cid, options?)`

```ts
async function queryBytes(cid: string, options?: QueryOptions): Promise<Uint8Array>
```

Container-only -- resolves via the host preimage lookup; **throws `CloudStorageHostUnavailableError` outside a container**. No gateway argument.

### `queryJson<T>(cid, options?)`

```ts
async function queryJson<T>(cid: string, options?: QueryOptions): Promise<T>
```

Container-only -- same semantics as `queryBytes`.

> Also standalone: `executeQuery`, `resolveQueryStrategy`, `verifyStored`, `authorizeAccount`, `checkAuthorization`, `createLazySigner`, and the `@parity/bulletin-sdk` re-exports (`cidFromBytes`, `cidToBytes`, `convertCid`, `parseCid`, `getContentHash`, `estimateAuthorization`, etc.). **Removed:** `getGateway`, static/standalone `computeCid`.

---

## Types

### `CloudStorageEnvironment`

```ts
type CloudStorageEnvironment = "paseo" | "summit"   // keyof typeof CloudStorageNetworks
```

The `environment` shorthand accepted by `create(...)`. Both `"paseo"` and `"summit"` are currently available.

### `Environment`

```ts
// re-exported from @parity/product-sdk-chain-client
type Environment = "polkadot" | "kusama" | "paseo" | "summit"
```

Broader chain-client union; `getChainAPI("polkadot" | "kusama")` currently throws "not yet available".

### `CreateCloudStorageClientOptions`

```ts
type CreateCloudStorageClientOptions =
    | { signer: PolkadotSigner; config?: Partial<ClientConfig>; environment: CloudStorageEnvironment }
    | {
        signer: PolkadotSigner;
        config?: Partial<ClientConfig>;
        genesisHash: `0x${string}`;
        descriptor: (typeof CloudStorageNetworks)[CloudStorageEnvironment]["descriptor"];   // PAPI bulletin descriptor
      }
```

`signer` is required on both shapes.

### `StoreResult`

```ts
interface StoreResult {
    cid?: CID;              // multiformats CID object; undefined for chunked-without-manifest
    size: number;
    blockNumber?: number;
    extrinsicIndex?: number;   // needed for renew()
    chunks?: ChunkDetails;
}
```

### `QueryOptions`

```ts
interface QueryOptions {
    lookupTimeoutMs?: number;   // per-lookup host preimage subscription timeout; default 30_000
    noReassemble?: boolean;     // return raw manifest bytes without recursing into chunks; default false
}
```

### `VerifyStoredOptions` / `ChainStoredEntry`

```ts
interface VerifyStoredOptions {
    block: number;    // required -- pass the blockNumber from a store() receipt
    index?: number;   // optional -- narrow to an exact slot
}

interface ChainStoredEntry {
    block: number;
    index: number;
    size: number;
    blockChunks: number;
}
```

### `HashAlgorithm`

```ts
HashAlgorithm.Blake2b256  // 0xb220 — default
HashAlgorithm.Sha2_256    // 0x12
HashAlgorithm.Keccak256   // 0x1b
```

### `CidCodec`

```ts
CidCodec.Raw     // 0x55 — default
CidCodec.DagPb   // 0x70
CidCodec.DagCbor // 0x71
```
