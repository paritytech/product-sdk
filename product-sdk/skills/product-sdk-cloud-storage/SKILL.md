---
name: product-sdk-cloud-storage
description: >
  Use when uploading or retrieving data via Cloud Storage, working with
  CID-based decentralized storage, IPFS gateway access, or the CloudStorageClient SDK.
  Covers upload, batch upload, fetch, query, CID computation, and gateway utilities.
---

# Product SDK Cloud Storage

`@parity/product-sdk-cloud-storage` is a TypeScript SDK for uploading and retrieving data via Cloud Storage -- a purpose-built parachain for decentralized data storage. Data is content-addressed using CIDv1 (blake2b-256 hash, raw codec) and retrievable via IPFS gateways.

## Key Concepts

- **Content-addressed storage**: Data is identified by its CID (Content Identifier), computed deterministically from the bytes via blake2b-256.
- **Two upload paths**: Inside a host container, uploads go through the host preimage API automatically. Standalone, a `PolkadotSigner` or dev signer is used.
- **Two query paths**: Inside a host container, queries use the host preimage lookup. Standalone, data is fetched from an IPFS gateway.
- **Environments**: `"polkadot"`, `"kusama"`, `"paseo"`, `"previewnet"` -- currently only `"paseo"` and `"previewnet"` have live gateways.

## Quick Start: Upload and Fetch

```ts
import { CloudStorageClient } from "@parity/product-sdk-cloud-storage";

// Create a client for the Paseo test network
const cloudStorage = await CloudStorageClient.create("paseo");

// Upload data (MUST be Uint8Array, not a string)
const data = new TextEncoder().encode(JSON.stringify({ title: "Hello Cloud Storage" }));
const result = await cloudStorage.upload(data);
console.log("CID:", result.cid);

// Fetch it back as JSON
const content = await cloudStorage.fetchJson<{ title: string }>(result.cid);
console.log(content.title); // "Hello Cloud Storage"
```

> **WARNING**: `upload()` expects `Uint8Array`, not strings. Always convert with `new TextEncoder().encode(...)`.

## CloudStorageClient

The `CloudStorageClient` class bundles a typed Cloud Storage API and IPFS gateway URL.

### Creating a Client

```ts
import { CloudStorageClient } from "@parity/product-sdk-cloud-storage";

// From an environment name
const client = await CloudStorageClient.create("paseo");

// From explicit API and gateway (custom setups)
import { getGateway } from "@parity/product-sdk-cloud-storage";
const custom = CloudStorageClient.from(myApi, "https://my-gateway.example/ipfs/");
```

### When to use each entry point

| Method | When to use | Size cost |
|--------|-------------|-----------|
| `CloudStorageClient.create("paseo")` | Quick prototyping | ~6.3 MB (all preset descriptors) |
| `CloudStorageClient.from(api, gateway)` | Production apps, BYOD | Only the descriptors you import |

### Uploading Data

```ts
const data = new TextEncoder().encode("raw file content");
const result = await client.upload(data);
// result.cid, result.kind, result.gatewayUrl

// With explicit signer and options
const result2 = await client.upload(data, mySigner, {
  waitFor: "finalized",
  timeoutMs: 60_000,
});
```

### Batch Upload

```ts
const items = [
  { data: new TextEncoder().encode("file A"), label: "a.txt" },
  { data: new TextEncoder().encode("file B"), label: "b.txt" },
];

const results = await client.batchUpload(items, undefined, {
  onProgress: (completed, total, current) => {
    console.log(`${completed}/${total}: ${current.label}`);
  },
});
```

### Fetching Data

```ts
// Raw bytes
const bytes = await client.fetchBytes(cid);

// Parsed JSON
const metadata = await client.fetchJson<{ name: string }>(cid);
```

### Utility Methods

```ts
// Compute CID without uploading
const cid = CloudStorageClient.computeCid(data);

// Check if CID exists
const exists = await client.cidExists(cid);

// Build gateway URL
const url = client.gatewayUrl(cid);

// Pre-flight authorization check
const auth = await client.checkAuthorization(address);
```

## Standalone Functions

For advanced use cases:

```ts
import {
  upload,
  batchUpload,
  computeCid,
  cidToPreimageKey,
  hashToCid,
  getGateway,
  fetchBytes,
  fetchJson,
} from "@parity/product-sdk-cloud-storage";
```

## Common Mistakes

1. **Passing a string to upload instead of Uint8Array**
2. **Forgetting that only `"paseo"` and `"previewnet"` have live gateways**
3. **Not handling batch failures** - `batchUpload` does NOT throw on individual failures
4. **Omitting signer in standalone mode** - Falls back to Alice dev signer (testnet only)

## Reference Files

- [cloud-storage-api.md](references/cloud-storage-api.md) - Full API surface
