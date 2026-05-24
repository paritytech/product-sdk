# Cloud Storage API Reference

Package: `@parity/product-sdk-cloud-storage`

## CloudStorageClient Class

### Static Methods

#### `CloudStorageClient.create(env)`

```ts
static async create(env: Environment): Promise<CloudStorageClient>
```

Create from an environment name.

#### `CloudStorageClient.from(api, gateway)`

```ts
static from(api: CloudStorageApi, gateway: string): CloudStorageClient
```

Create from explicit API and gateway.

#### `CloudStorageClient.computeCid(data)`

```ts
static computeCid(data: Uint8Array): string
```

Compute CID without uploading.

#### `CloudStorageClient.hashToCid(hexHash, hashCode?, codec?)`

```ts
static hashToCid(hexHash: `0x${string}`, hashCode?: HashAlgorithm, codec?: CidCodec): string
```

Reconstruct CID from on-chain hex hash.

### Instance Methods

#### `client.upload(data, signer?, options?)`

```ts
async upload(
    data: Uint8Array,
    signer?: PolkadotSigner,
    options?: UploadOptions,
): Promise<UploadResult>
```

#### `client.batchUpload(items, signer?, options?)`

```ts
async batchUpload(
    items: BatchUploadItem[],
    signer?: PolkadotSigner,
    options?: BatchUploadOptions,
): Promise<BatchUploadResult[]>
```

#### `client.checkAuthorization(address)`

```ts
async checkAuthorization(address: string): Promise<AuthorizationStatus>
```

#### `client.fetchBytes(cid, options?)`

```ts
async fetchBytes(cid: string, options?: QueryOptions): Promise<Uint8Array>
```

#### `client.fetchJson<T>(cid, options?)`

```ts
async fetchJson<T>(cid: string, options?: QueryOptions): Promise<T>
```

#### `client.cidExists(cid)`

```ts
async cidExists(cid: string): Promise<boolean>
```

#### `client.gatewayUrl(cid)`

```ts
gatewayUrl(cid: string): string
```

---

## Standalone Functions

### `computeCid(data)`

```ts
function computeCid(data: Uint8Array): string
```

### `cidToPreimageKey(cid)`

```ts
function cidToPreimageKey(cid: string): `0x${string}`
```

### `hashToCid(hexHash, hashCode?, codec?)`

```ts
function hashToCid(hexHash: `0x${string}`, hashCode?: HashAlgorithm, codec?: CidCodec): string
```

### `getGateway(env)`

```ts
function getGateway(env: Environment): string
```

### `fetchBytes(cid, gateway, options?)`

```ts
async function fetchBytes(cid: string, gateway: string, options?: FetchOptions): Promise<Uint8Array>
```

### `fetchJson<T>(cid, gateway, options?)`

```ts
async function fetchJson<T>(cid: string, gateway: string, options?: FetchOptions): Promise<T>
```

---

## Types

### `Environment`

```ts
type Environment = "polkadot" | "kusama" | "paseo" | "previewnet"
```

### `UploadResult`

```ts
type UploadResult =
    | { kind: "transaction"; cid: string; blockHash: string; gatewayUrl?: string }
    | { kind: "preimage"; cid: string; preimageKey: string; gatewayUrl?: string }
```

### `BatchUploadItem`

```ts
interface BatchUploadItem {
    data: Uint8Array;
    label: string;
}
```

### `UploadOptions`

```ts
interface UploadOptions {
    gateway?: string;
    waitFor?: "best-block" | "finalized";
    timeoutMs?: number;
    onStatus?: (status: TxStatus) => void;
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
