---
"@parity/product-sdk-tx": minor
"@parity/product-sdk-contracts": minor
"@parity/product-sdk-cloud-storage": patch
"@parity/product-sdk": minor
---

Convert the fallible operations of `@parity/product-sdk-tx` from throwing to returning a `Result` (phase 3.1 of the SDK-wide throw→Result initiative).

**Breaking (`@parity/product-sdk-tx`):**

- `submitAndWatch` and `batchSubmitAndWatch` now return `Promise<Result<TxResult, TxError>>` instead of resolving `TxResult` / rejecting a `TxError`.
- `ensureAccountMapped` now returns `Promise<Result<TxResult | null, TxError>>` — `ok(null)` still means "already mapped" (an expected state, not a failure).
- `extractTransaction` now returns `Result<SubmittableTransaction, TxDryRunError>` (still synchronous) instead of throwing `TxDryRunError`.
- `TxAccountMappingError` now extends `TxError` (was `Error`), so it flows on the `err` channel and carries the shared `SdkError` marker. `TxError` (and thus all tx errors) now implements `SdkError` (`source: "tx"`).

Pure/sync helpers and utilities (`createDevSigner`, `getDevPublicKey`, `applyWeightBuffer`, `calculateDelay`, `withRetry`, `formatDispatchError`, `formatDryRunError`, `isSigningRejection`, `isAccountMapped`) are unchanged — a `throw` on bad input remains idiomatic there.

Migrate `const r = await submitAndWatch(...)` to `const r = await submitAndWatch(...); if (!r.ok) handle(r.error); use(r.value)`.

**Breaking (`@parity/product-sdk-contracts`):**

- `ensureContractAccountMapped` now returns `Promise<Result<TxResult | null, TxError>>`, mirroring the underlying `ensureAccountMapped` it delegates to.

**Internal (`@parity/product-sdk-cloud-storage`):** `authorizeAccount` adapts to tx's new Result internally and keeps its existing throwing contract (it will convert in a later phase). No public API change.
