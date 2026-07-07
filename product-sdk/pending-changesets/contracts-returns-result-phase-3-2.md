---
"@parity/product-sdk-contracts": minor
"@parity/product-sdk": minor
---

Convert the fallible operations of `@parity/product-sdk-contracts` from throwing to returning a `Result` (phase 3.2 of the SDK-wide throw→Result initiative).

**Breaking:**

- `ContractMethod.tx` now returns `Promise<Result<TxResult, ContractError | TxError>>` instead of resolving `TxResult` / throwing. Pre-submit failures (`ContractSignerMissingError`, a failed dry-run `ContractDryRunFailedError`, or a `ContractRevertedError`) surface on the `err` channel, as do submission/dispatch failures from `@parity/product-sdk-tx` (`TxError`). This also fixes a latent mismatch introduced by phase 3.1, where `.tx` already returned tx's `Result` but was still typed `Promise<TxResult>`.
- `ContractMethod.prepare` now returns `Promise<Result<BatchableCall, ContractError>>`.
- `withLiveContractAddresses` now returns `Promise<Result<CdmJson, ContractError>>`.
- `ContractManager.fromLive` and `ContractManager.fromLiveClient` now return `Promise<Result<ContractManager, ContractError>>`.
- `ContractError` (and all its subclasses) implements the shared `SdkError` marker (`source: "contracts"`).

Migrate `const r = await contract.method.tx(...)` to `const r = await contract.method.tx(...); if (!r.ok) handle(r.error); use(r.value)`.

**Unchanged (deliberately):**

- **`ContractMethod.query` keeps returning `QueryResult<T>`.** `QueryResult` already models the dry-run outcome as a tagged union and never throws for a revert — a revert is an *expected* outcome of a dry-run (a value, not an error), the same principle as host's `getChainSpec` returning `ok(null)`. Wrapping it in `Result` would force a two-level `if (r.ok && r.value.success)` at every call site; flattening it would lose `gasRequired` on success and misclassify a revert as an error.
- Synchronous factories (`wrapContract`, `createContract`, `createContractRuntime`), the PVM artifact loaders, and the codegen helpers are unchanged — they are construction / build-time tooling, not fallible runtime operations.
