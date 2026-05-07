---
"@parity/product-sdk-bulletin": minor
"@parity/product-sdk": minor
---

**Bulletin: wrap `@parity/bulletin-sdk` for chunked uploads + on-chain verification.**

`BulletinClient` now wraps upstream `AsyncBulletinClient`, gaining native chunking (>2 MiB), DAG-PB manifests, and progress events. Uploads sign and submit a `TransactionStorage.store` extrinsic; reads go through the host's preimage subscription (container-only, matching PR #26's stance — no public-gateway fetches); CID-on-chain verification is exposed via a new helper.

### Breaking changes — `@parity/product-sdk-bulletin`

| Before | After |
| --- | --- |
| `BulletinClient.create("paseo")` | `BulletinClient.create({ environment: "paseo", signer })` — signer is now required |
| `BulletinClient.from(api)` | `BulletinClient.from(inner, api)` — pass a pre-built `AsyncBulletinClient` |
| `bulletin.upload(data, signer?)` | `await bulletin.store(data).send()` |
| `bulletin.batchUpload([...])` | Loop `for (const item of items) await bulletin.store(item.data).send()` (upstream has no batch helper) |
| `result.kind === "preimage" \| "transaction"` (discriminated union) | `result: StoreResult` from upstream (`{ cid?, size, blockNumber?, extrinsicIndex?, chunks? }`) |
| `computeCid(data)` (sync) | `await calculateCid(data)` (async — uses Web Crypto) |
| `import { computeCid }` | `import { calculateCid }` (re-exported from upstream) |

### New surface — `@parity/product-sdk-bulletin`

- `BulletinClient.create({ environment, signer, config? })` — environment shorthand using built-in `BulletinChain` presets and our chain-client.
- `BulletinClient.create({ genesisHash, descriptor, signer, config? })` — explicit form for custom networks.
- `BulletinClient.store(data) → StoreBuilder` and the rest of upstream's fluent API (`.withChunkSize`, `.withCallback`, `.withCodec`, `.withManifest`, `.withWaitFor`).
- `BulletinClient.fetchBytes(cid, options?)` / `BulletinClient.fetchJson(cid, options?)` — read CIDs through the host's preimage subscription. DAG-PB chunked content is reassembled transparently; pass `{ noReassemble: true }` to inspect the raw manifest.
- `BulletinClient.verifyOnChain(cid, { block, index? })` — verify a CID was recorded in `TransactionStorage.Transactions` at a specific block. Pass `blockNumber` from a `store(...).send()` receipt for an O(1) check.
- `BulletinClient.authorizeAccount` / `authorizePreimage` / `renew` / `estimateAuthorization` — direct passthroughs to upstream builders.
- `createLazySigner(getSigner)` — build a `PolkadotSigner` whose underlying signer is resolved per-call. Lets the bulletin client be constructed before an account is selected, picks up account changes between calls, throws clearly on use when no signer is available.
- `BulletinChain.paseo` — preset with genesis hash and descriptor.
- `ProductBulletinError` — base class for read-side errors raised by this package (host availability / lookup timeout / lookup interrupted / CID format / authorization). Upstream `BulletinError` (with `code`, `retryable`, `recoveryHint`) covers upload-side failures.
- Re-exports the upstream surface (`AsyncBulletinClient`, `BulletinPreparer`, `MockBulletinClient`, `calculateCid`, `parseCid`, `cidFromBytes`, `cidToBytes`, `convertCid`, `getContentHash`, `estimateAuthorization`, `WaitFor`, `TxStatus`, `ChunkStatus`, `ErrorCode`, etc.) so consumers don't need a separate `@parity/bulletin-sdk` import.

### Breaking changes — `@parity/product-sdk`

- `BulletinApi.computeCid(data)` is now `Promise<string>` (was sync `string`). Upstream's `calculateCid` is async because it uses Web Crypto.
- `BulletinApi.upload(data)` now requires a wallet to be connected and an account selected — uploads fail with a clear "no signer available" error otherwise. `createApp` wires a lazy signer via `SignerManager.getSigner()` so the bulletin client can still be constructed at startup.
- `BulletinConfig.environment` narrowed from the chain-client `Environment` union to `BulletinEnvironment` (`"paseo"` only) — matches what `BulletinChain` actually has presets for.
- Top-level `computeCid` re-export removed; `calculateCid` re-exported from `@parity/product-sdk-bulletin`.

### Migration

- Connect a wallet and select an account before calling `app.bulletin.upload(...)`.
- Replace `bulletin.upload(data)` call sites with `await bulletin.store(data).send()`; read `result.cid?.toString()` for the CID string. Handle the `undefined` case (chunked uploads with manifest disabled) explicitly.
- Replace `computeCid(data)` with `await calculateCid(data)` (note: returns a `CID` object — call `.toString()` for the base32 string).
- For BYOD setups, build an `AsyncBulletinClient` first (`new AsyncBulletinClient(api, signer, papiClient.submit, config?, onDestroy?)`) and pass it to `BulletinClient.from(inner, api)`.
- Catch upstream `BulletinError` for upload/store failures (it carries `code` and `retryable`); catch `ProductBulletinError` (or its subclasses `BulletinHostUnavailableError` / `BulletinLookupTimeoutError` / `BulletinLookupInterruptedError` / `BulletinCidError` / `BulletinAuthorizationError`) for read-side failures.
