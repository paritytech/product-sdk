---
name: product-sdk-cloud-storage
description: >
  Use when uploading or retrieving data via Cloud Storage, working with
  CID-based decentralized storage, or the CloudStorageClient SDK. Covers the
  store() upload builder, chunked uploads, container-only reads (fetch/query),
  CID helpers, and authorization.
---

# Product SDK Cloud Storage

`@parity/product-sdk-cloud-storage` is a TypeScript SDK for uploading and retrieving data via Cloud Storage -- a purpose-built parachain for decentralized data storage. Data is content-addressed using CIDv1 (blake2b-256 hash, raw codec). It wraps `@parity/bulletin-sdk` (chunking, DAG-PB manifests, CID calculation, progress events) and routes reads through the host's preimage subscription.

## Key Concepts

- **Content-addressed storage**: Data is identified by its CID (Content Identifier), computed deterministically from the bytes via blake2b-256.
- **Uploads always need a signer**: Every `store(...)` submits a `TransactionStorage.store` extrinsic, so `create(...)` **requires** a `signer`. In-container vs standalone only changes *where the signer comes from* (the host's account vs a `PolkadotSigner` you supply) -- there is no signer-less host upload path.
- **Reads are container-only**: `fetchBytes`/`fetchJson`/`queryBytes` resolve content through the host's preimage subscription and **require a host container**. Outside a container they **throw `CloudStorageHostUnavailableError`** -- the SDK does **not** fall back to a public IPFS gateway. A product that needs a standalone read path must branch on `isInsideContainer()` and perform its own gateway fetch.
- **Environments**: `create({ environment })` accepts `"paseo"` and `"summit"` (the `CloudStorageEnvironment` presets -- keys of `CloudStorageNetworks`; both currently available). `"polkadot"`/`"kusama"` are not yet available (compile error, and `getChainAPI` throws).

## Quick Start: Upload and Fetch

```ts
import { CloudStorageClient, createLazySigner } from "@parity/product-sdk-cloud-storage";

// Create a client for the Paseo test network. A signer is REQUIRED -- every
// store() submits a transaction. createLazySigner defers signer resolution so
// you can build the client before an account is selected.
const cloudStorage = await CloudStorageClient.create({
  environment: "paseo",
  // getCurrentSigner returns the active `PolkadotSigner | null`
  // (e.g. wrap your signer manager / host account here).
  signer: createLazySigner(() => getCurrentSigner()),
});

// Upload data (MUST be Uint8Array, not a string) via the store() builder
const data = new TextEncoder().encode(JSON.stringify({ title: "Hello Cloud Storage" }));
const result = await cloudStorage.store(data).send();
console.log("CID:", result.cid?.toString());        // result.cid is a CID object (undefined for chunked-without-manifest)
console.log("block:", result.blockNumber, "size:", result.size);

// Fetch it back as JSON (requires a host container -- throws CloudStorageHostUnavailableError standalone)
const content = await cloudStorage.fetchJson<{ title: string }>(result.cid!.toString());
console.log(content.title); // "Hello Cloud Storage"
```

> **WARNING**: `store()` expects `Uint8Array`, not strings. Always convert with `new TextEncoder().encode(...)`.

## CloudStorageClient

The `CloudStorageClient` wraps the upstream `@parity/bulletin-sdk` client and adds network presets, container-routed read helpers, and a pre-flight authorization check.

### Creating a Client

```ts
import { CloudStorageClient, CloudStorageNetworks, createLazySigner } from "@parity/product-sdk-cloud-storage";

// Environment shorthand (signer required)
const client = await CloudStorageClient.create({ environment: "paseo", signer });

// Explicit network / BYOD -- spread a preset (or supply your own genesisHash + descriptor)
const custom = await CloudStorageClient.create({
  ...CloudStorageNetworks.paseo,
  signer,
  config: { defaultChunkSize: 1 << 20 },
});

// From a pre-built AsyncBulletinClient + typed API (you own the connection lifecycle)
const fromInner = CloudStorageClient.from(inner, api);
```

### When to use each entry point

| Method | When to use |
|--------|-------------|
| `create({ environment, signer })` | Quick start against a preset network |
| `create({ ...descriptor, signer })` | Custom / BYOD network (explicit `genesisHash` + `descriptor`) |
| `from(inner, api)` | You already own the `AsyncBulletinClient` and its connection lifecycle |

### Uploading Data

Uploads use the fluent `store(data)` builder (re-exported from `@parity/bulletin-sdk`):

```ts
const data = new TextEncoder().encode("raw file content");

// Simple signed upload
const result = await client.store(data).send();
// result.cid (CID | undefined), result.size, result.blockNumber, result.extrinsicIndex

// Chained options
const result2 = await client
  .store(data)
  .withWaitFor("finalized")        // "in_block" | "finalized"
  .send();

// Pre-authorized content can be stored fee-free by anyone via an unsigned tx
await client.authorizePreimage(contentHash, BigInt(data.length));
const result3 = await client.store(data).sendUnsigned();
```

### Chunked Uploads (large files)

There is no `batchUpload`. For large files, force the chunked path with `withChunkSize` -- a DAG-PB manifest (default) ties the chunks together and `result.cid` is the manifest CID:

```ts
const result = await client
  .store(largeFile)
  .withChunkSize(1 << 20)             // 1 MiB chunks
  .withCallback((evt) => console.log(evt))   // progress events
  .send();
```

### Fetching Data

`fetchBytes`/`fetchJson` are **instance methods** and **container-only** (host preimage lookup; throw `CloudStorageHostUnavailableError` standalone):

```ts
// Raw bytes
const bytes = await client.fetchBytes(cid);

// Parsed JSON
const metadata = await client.fetchJson<{ name: string }>(cid);
```

### Utility Methods

```ts
import { calculateCid } from "@parity/product-sdk-cloud-storage";

// Compute a CID without uploading (standalone helper -- async, returns a CID object)
const cid = await calculateCid(data);

// Confirm a CID landed on-chain at a known block (pass the block from a store() receipt)
const entry = await client.verifyStored(result.cid!.toString(), { block: result.blockNumber! });

// Pre-flight authorization check
const auth = await client.checkAuthorization(address);

// Estimate the authorization (transactions + bytes) a payload needs
const need = client.estimateAuthorization(data.length);
```

## Standalone Functions

For advanced use cases:

```ts
import {
  cidToPreimageKey,
  hashToCid,
  calculateCid,   // async; returns a CID object
  queryBytes,     // container-only read (host preimage); throws CloudStorageHostUnavailableError standalone
  queryJson,      // container-only read (host preimage); throws CloudStorageHostUnavailableError standalone
  executeQuery,
  resolveQueryStrategy,
} from "@parity/product-sdk-cloud-storage";
```

> `upload`, `batchUpload`, `cidExists`, `gatewayUrl`, `getGateway`, and static `computeCid`/`hashToCid` **no
> longer exist**. Uploads go through the `store(...)` builder; CID computation is the standalone async
> `calculateCid`; `fetchBytes`/`fetchJson` are `CloudStorageClient` instance methods (container-only, no
> gateway argument).

## Common Mistakes

1. **Passing a string to `store()` instead of `Uint8Array`** - convert with `new TextEncoder().encode(...)`.
2. **Forgetting that `create()` requires a signer** - every `store()` submits a transaction; use `createLazySigner` if no account is selected yet.
3. **Treating `result.cid` as a string** - it's a `CID` object (or `undefined` for chunked-without-manifest); call `.toString()`.
4. **Expecting reads to work standalone** - `fetchBytes`/`fetchJson`/`queryBytes` are container-only and throw `CloudStorageHostUnavailableError` outside a host.

## Reference Files

- [cloud-storage-api.md](references/cloud-storage-api.md) - Full API surface
