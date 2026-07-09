---
"@parity/result": minor
"@parity/product-sdk-tx": minor
"@parity/product-sdk-contracts": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk-statement-store": minor
"@parity/product-sdk-host": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk": minor
---

Introduce an SDK-wide `Result` error model: fallible operations across the
`@parity/product-sdk-*` packages now return a typed `Result<T, E>` instead of
throwing, so consumers branch on `r.ok` and get typed errors on the `err`
channel. See the `guides/migrating-to-result` migration guide.

**New package — `@parity/result`:** a zero-dependency leaf exporting
`Result<T, E>` (`{ ok: true; value } | { ok: false; error }`), `ok()` / `err()`,
and a cross-package `SdkError` marker interface + `isSdkError(e)` guard. Every
package's base error implements the marker (with a `source` string like `"tx"`),
so `isSdkError(e)` recognizes any SDK-origin error without importing per-package
classes. `@parity/product-sdk` re-exports `Result` / `ok` / `err` / `SdkError` /
`isSdkError`.

**Breaking — these now return `Result` instead of throwing:**

- `@parity/product-sdk-tx`: `submitAndWatch`, `batchSubmitAndWatch` → `Result<TxResult, TxError>`; `ensureAccountMapped` → `Result<TxResult | null, TxError>` (`ok(null)` = already mapped); `extractTransaction` → `Result<SubmittableTransaction, TxDryRunError>` (sync). `TxAccountMappingError` now extends `TxError`.
- `@parity/product-sdk-contracts`: `contract.<method>.tx` → `Result<TxResult, ContractError | TxError>`; `.prepare` → `Result<BatchableCall, ContractError>`; `withLiveContractAddresses` and `ContractManager.fromLive` / `fromLiveClient` → `Result<…, ContractError>`; `ensureContractAccountMapped` → `Result<TxResult | null, TxError>`. **`contract.<method>.query` is unchanged** — it keeps returning `QueryResult<T>`, since a dry-run revert is an expected outcome (a value), not an error.
- `@parity/product-sdk-cloud-storage`: `queryBytes`, `queryJson`, `executeQuery`, `checkAuthorization`, `verifyStored` (`ok(null)` = not recorded at that block), `authorizeAccount`, and the equivalent `CloudStorageClient` read methods (`fetchBytes` / `fetchJson` / `checkAuthorization` / `verifyStored`). The `CloudStorageClient` methods that forward to the upstream client (`store`, `authorizePreimage`, `renew`, `estimateAuthorization`, and the `authorizeAccount` *method*) are unchanged.
- `@parity/product-sdk-statement-store`: `StatementStoreClient.publish` and `ChannelStore.write` → `Result<void, StatementStoreError>` (were `Promise<boolean>`). The old boolean swallowed the failure reason into `false`; the `Result` now carries it (`StatementConnectionError`, `StatementDataTooLargeError`, `StatementSubmitError`). **Note:** a bare `if (result)` now always passes (a `Result` object is truthy) — audit call sites for `.ok`.
- `@parity/product-sdk` umbrella: `createApp().cloudStorage.upload` / `fetch` now return `Result` (`computeCid` unchanged — pure).

`@parity/product-sdk-host` and `@parity/product-sdk-signer` (whose public
operations already returned `Result`) migrate onto the shared `@parity/result`
package and adopt the `SdkError` marker; no further API change.

**Unchanged everywhere:** pure/sync helpers and factories, build-time codegen,
lifecycle methods, and subscription APIs continue to throw or return their
existing types — `Result` is reserved for fallible runtime operations.
