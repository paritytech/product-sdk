---
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk": minor
---

Convert the fallible read-side operations of `@parity/product-sdk-cloud-storage` from throwing to returning a `Result` (phase 3.3 of the SDK-wide throw→Result initiative).

**Breaking:**

- `queryBytes`, `executeQuery` now return `Promise<Result<Uint8Array, ProductCloudStorageError>>`.
- `queryJson<T>` now returns `Promise<Result<T, ProductCloudStorageError>>` (JSON parse failures surface on the `err` channel).
- `checkAuthorization` now returns `Promise<Result<AuthorizationStatus, CloudStorageAuthorizationError>>`.
- `verifyStored` now returns `Promise<Result<ChainStoredEntry | null, ProductCloudStorageError>>` — `ok(null)` still means "CID not recorded at that block" (an expected absence, not a failure); a malformed CID or query failure surfaces on `err`.
- `authorizeAccount` now returns `Promise<Result<{ blockHash: string }, ProductCloudStorageError | TxError>>`.
- The equivalent `CloudStorageClient` read methods — `fetchBytes`, `fetchJson`, `checkAuthorization`, `verifyStored` — return the same `Result` shapes.
- `ProductCloudStorageError` (and all its subclasses) implements the shared `SdkError` marker (`source: "cloud-storage"`).

Migrate `const bytes = await client.fetchBytes(cid)` to `const r = await client.fetchBytes(cid); if (!r.ok) handle(r.error); use(r.value)`.

**Unchanged (deliberately):**

- `CloudStorageClient` methods that forward to the upstream `AsyncBulletinClient` — `store`, `authorizeAccount` (the client method, distinct from the free function), `authorizePreimage`, `renew`, `estimateAuthorization` — return upstream builders and are the upstream client's contract; out of scope.
- Synchronous helpers/factories (`hashToCid`, `cidToPreimageKey`, `createLazySigner`, `CloudStorageClient.create`/`from`/`destroy`) and the internal `resolveQueryStrategy` are unchanged.
- The umbrella `@parity/product-sdk` app-level `cloudStorage.fetch` facade keeps its throwing `Promise<Uint8Array>` contract for now; the umbrella surface converts to `Result` holistically in the final phase.
