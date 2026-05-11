---
name: product-sdk-bulletin
description: >
  Use when uploading or retrieving data on the Polkadot Bulletin Chain, working with
  CID-based decentralized storage, IPFS gateway access, or the BulletinClient SDK.
  Covers upload, batch upload, fetch, query, CID computation, and gateway utilities.
---

# Product SDK Bulletin Chain

`@parity/product-sdk-bulletin` is a TypeScript SDK for uploading and retrieving data on the Polkadot Bulletin Chain -- a purpose-built parachain for decentralized data storage. Data is content-addressed using CIDv1 (blake2b-256 hash, raw codec) and retrievable via IPFS gateways.

## Key Concepts

- **Content-addressed storage**: Data is identified by its CID (Content Identifier), computed deterministically from the bytes via blake2b-256.
- **Two upload paths**: Inside a host container, uploads go through the host preimage API automatically. Standalone, a `PolkadotSigner` or dev signer is used.
- **Two query paths**: Inside a host container, queries use the host preimage lookup. Standalone, data is fetched from an IPFS gateway.
- **Environments**: `"polkadot"`, `"kusama"`, `"paseo"`, `"previewnet"` -- currently only `"paseo"` and `"previewnet"` have live gateways.

## Quick Start: Upload and Fetch

```ts
import { BulletinClient } from "@parity/product-sdk-bulletin";

// Create a client for the Paseo test network
const bulletin = await BulletinClient.create("paseo");

// Upload data (MUST be Uint8Array, not a string)
const data = new TextEncoder().encode(JSON.stringify({ title: "Hello Bulletin" }));
const result = await bulletin.upload(data);
console.log("CID:", result.cid);

// Fetch it back as JSON
const content = await bulletin.fetchJson<{ title: string }>(result.cid);
console.log(content.title); // "Hello Bulletin"
```

> **WARNING**: `upload()` expects `Uint8Array`, not strings. Always convert with `new TextEncoder().encode(...)`.

## BulletinClient

The `BulletinClient` class bundles a typed Bulletin API and IPFS gateway URL.

### Creating a Client

```ts
import { BulletinClient } from "@parity/product-sdk-bulletin";

// From an environment name
const client = await BulletinClient.create("paseo");

// From explicit API and gateway (custom setups)
import { getGateway } from "@parity/product-sdk-bulletin";
const custom = BulletinClient.from(myApi, "https://my-gateway.example/ipfs/");
```

### When to use each entry point

| Method | When to use | Size cost |
|--------|-------------|-----------|
| `BulletinClient.create("paseo")` | Quick prototyping | ~6.3 MB (all preset descriptors) |
| `BulletinClient.from(api, gateway)` | Production apps, BYOD | Only the descriptors you import |

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
const cid = BulletinClient.computeCid(data);

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
} from "@parity/product-sdk-bulletin";
```

## Common Mistakes

1. **Passing a string to upload instead of Uint8Array**
2. **Forgetting that only `"paseo"` and `"previewnet"` have live gateways**
3. **Not handling batch failures** - `batchUpload` does NOT throw on individual failures
4. **Omitting signer in standalone mode** - Falls back to Alice dev signer (testnet only)

## Reference Files

- [bulletin-api.md](references/bulletin-api.md) - Full API surface
