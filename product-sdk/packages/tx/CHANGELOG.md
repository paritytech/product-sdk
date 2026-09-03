# @parity/product-sdk-tx

## 0.4.7

### Patch Changes

- @parity/product-sdk-keys@0.3.24

## 0.4.6

### Patch Changes

- @parity/product-sdk-keys@0.3.23

## 0.4.5

### Patch Changes

- @parity/product-sdk-keys@0.3.22

## 0.4.4

### Patch Changes

- @parity/product-sdk-keys@0.3.21

## 0.4.3

### Patch Changes

- @parity/product-sdk-keys@0.3.20

## 0.4.2

### Patch Changes

- @parity/product-sdk-keys@0.3.19

## 0.4.1

### Patch Changes

- @parity/product-sdk-keys@0.3.18

## 0.4.0

### Minor Changes

- bffc04a: Stop collapsing pre-inclusion transaction failures to opaque errors.

  New `TxValidityError` (extends `TxError`; raw failure payload on `.reason`,
  human-readable `.formatted`): `submitAndWatch` now puts it on the `err`
  channel for _pre-inclusion_ validity/submission failures: polkadot-api
  rejects the subscription with an `InvalidTxError` whose `.error` carries the
  decoded `TransactionValidityError` — e.g. `InvalidTransaction::Payment` when
  the submitter can't pay or isn't authorized. The payload is preserved on
  `.reason` and formatted via the new `formatValidityError` helper
  (`{ type: "Invalid", value: { type: "Payment" } }` → `"Invalid.Payment"`).
  Previously this surfaced as a base `TxError` whose message was raw JSON.

  An _included_ failure event that carries no `dispatchError` — an anomaly,
  since `dispatchError` normally exists once a tx is included — is classified
  as a `TxDispatchError` with a neutral message, no longer the placeholder
  `"unknown error"`. It is deliberately **not** a `TxValidityError`: that type
  is reserved for genuine pre-inclusion failures, and this case is
  post-inclusion.

  `formatValidityError(reason)` is exported alongside the other formatters.

  `withRetry` treats `TxValidityError` as non-retryable, matching how these
  failures behaved when they surfaced as `TxDispatchError`.

### Patch Changes

- @parity/product-sdk-keys@0.3.17

## 0.3.2

### Patch Changes

- @parity/product-sdk-keys@0.3.16

## 0.3.1

### Patch Changes

- @parity/product-sdk-keys@0.3.15

## 0.3.0

### Minor Changes

- cb0098f: Introduce an SDK-wide `Result` error model: fallible operations across the
  `@parity/product-sdk-*` packages now return a typed `Result<T, E>` instead of
  throwing, so consumers branch on `r.ok` and get typed errors on the `err`
  channel. See the `guides/migrating-to-result` migration guide.

  **New package — `@parity/result`:** a generic, domain-agnostic, zero-dependency
  leaf exporting `Result<T, E>` (`{ ok: true; value } | { ok: false; error }`),
  `ok()` / `err()`, `normalizeError(cause, ErrorClass)` (coerce a caught value to a
  typed error — the single error-normalization strategy, replacing ad-hoc `as`
  casts), `isErrorOf(e, ErrorClass)` (generic `instanceof` guard), and
  `unwrapOk` / `unwrapErr` (framework-agnostic test/script assertions). It carries
  no product-sdk specifics, so it can be embedded anywhere.

  **New package — `@parity/product-sdk-errors`:** a zero-dependency leaf holding
  the product-sdk-specific cross-package `SdkError` marker interface +
  `isSdkError(e)` guard. Every package's base error implements the marker (with a
  `source` string like `"tx"`), so `isSdkError(e)` recognizes any SDK-origin error
  without importing per-package classes. `@parity/product-sdk` re-exports `Result` /
  `ok` / `err` / `isErrorOf` from `@parity/result` and `SdkError` / `isSdkError`
  from `@parity/product-sdk-errors`.

  **Breaking — these now return `Result` instead of throwing:**

  - `@parity/product-sdk-tx`: `submitAndWatch`, `batchSubmitAndWatch` → `Result<TxResult, TxError>`; `ensureAccountMapped` → `Result<TxResult | null, TxError>` (`ok(null)` = already mapped); `extractTransaction` → `Result<SubmittableTransaction, TxDryRunError>` (sync). `TxAccountMappingError` now extends `TxError`.
  - `@parity/product-sdk-contracts`: `contract.<method>.tx` → `Result<TxResult, ContractError | TxError>`; `.prepare` → `Result<BatchableCall, ContractError>`; `withLiveContractAddresses` and `ContractManager.fromLive` / `fromLiveClient` → `Result<…, ContractError>`; `ensureContractAccountMapped` → `Result<TxResult | null, TxError>`. **`contract.<method>.query` is unchanged** — it keeps returning `QueryResult<T>`, since a dry-run revert is an expected outcome (a value), not an error.
  - `@parity/product-sdk-cloud-storage`: `queryBytes`, `queryJson`, `executeQuery`, `checkAuthorization`, `verifyStored` (`ok(null)` = not recorded at that block), `authorizeAccount`, and the equivalent `CloudStorageClient` read methods (`fetchBytes` / `fetchJson` / `checkAuthorization` / `verifyStored`). The `CloudStorageClient` methods that forward to the upstream client (`store`, `authorizePreimage`, `renew`, `estimateAuthorization`, and the `authorizeAccount` _method_) are unchanged.
  - `@parity/product-sdk-statement-store`: `StatementStoreClient.publish` and `ChannelStore.write` → `Result<void, StatementStoreError>` (were `Promise<boolean>`). The old boolean swallowed the failure reason into `false`; the `Result` now carries it (`StatementConnectionError`, `StatementDataTooLargeError`, `StatementSubmitError`). **Note:** a bare `if (result)` now always passes (a `Result` object is truthy) — audit call sites for `.ok`.
  - `@parity/product-sdk` umbrella: `createApp().cloudStorage.upload` / `fetch` now return `Result` (`computeCid` unchanged — pure).

  `@parity/product-sdk-host` and `@parity/product-sdk-signer` (whose public
  operations already returned `Result`) migrate onto the shared `@parity/result`
  package and adopt the `SdkError` marker from `@parity/product-sdk-errors`; no
  further API change.

  **Unchanged everywhere:** pure/sync helpers and factories, build-time codegen,
  lifecycle methods, and subscription APIs continue to throw or return their
  existing types — `Result` is reserved for fallible runtime operations.

### Patch Changes

- Updated dependencies [cb0098f]
  - @parity/result@0.2.0
  - @parity/product-sdk-errors@0.2.0
  - @parity/product-sdk-keys@0.3.14

## 0.2.17

### Patch Changes

- @parity/product-sdk-keys@0.3.13

## 0.2.16

### Patch Changes

- @parity/product-sdk-keys@0.3.12

## 0.2.15

### Patch Changes

- 8dd1232: chore(deps): bump polkadot-api to 2.1.6

  Updates the `polkadot-api` catalog entry `^2.1.5` → `^2.1.6` (2.1.6 carries the
  double-notification fix). Every published package resolves `polkadot-api`
  through `catalog:`, so each one's published `dependencies` range moves to
  `^2.1.6`. There is no source change in any package — these are patch bumps to
  ship the new floor via the published `catalog:` resolution.

  Releases the catalog bump from #223, which was merged to `main` without a
  changeset.

- Updated dependencies [8dd1232]
  - @parity/product-sdk-keys@0.3.11

## 0.2.14

### Patch Changes

- @parity/product-sdk-keys@0.3.10

## 0.2.13

### Patch Changes

- @parity/product-sdk-keys@0.3.9

## 0.2.12

### Patch Changes

- @parity/product-sdk-keys@0.3.8

## 0.2.11

### Patch Changes

- @parity/product-sdk-keys@0.3.7

## 0.2.10

### Patch Changes

- @parity/product-sdk-keys@0.3.6

## 0.2.9

### Patch Changes

- @parity/product-sdk-keys@0.3.5

## 0.2.8

### Patch Changes

- @parity/product-sdk-keys@0.3.4

## 0.2.7

### Patch Changes

- dc3a452: Bump shared catalog dependencies to their latest within range. Dependency-range updates only; no public API changes:

  - `polkadot-api` `^2.1.2` → `^2.1.5` (all packages listed)
  - `@polkadot-labs/hdkd-helpers` `^0.0.27` → `^0.0.30` (contracts, keys, tx)
  - `viem` `^2.46.2` → `^2.52.0` (contracts)
  - `@novasamatech/host-api` & `@novasamatech/host-api-wrapper` `^0.8.0` → `^0.8.3` (signer's optional deps; host/statement-store carry them as dev-only/unchanged peers)

- Updated dependencies [dc3a452]
  - @parity/product-sdk-keys@0.3.3

## 0.2.6

### Patch Changes

- @parity/product-sdk-keys@0.3.2

## 0.2.5

### Patch Changes

- @parity/product-sdk-keys@0.3.1

## 0.2.4

### Patch Changes

- Updated dependencies [4c13257]
  - @parity/product-sdk-keys@0.3.0

## 0.2.3

### Patch Changes

- @parity/product-sdk-keys@0.2.3

## 0.2.2

### Patch Changes

- @parity/product-sdk-keys@0.2.2

## 0.2.1

### Patch Changes

- @parity/product-sdk-keys@0.2.1

## 0.2.0

### Minor Changes

- 646d591: **Bump novasama 0.6 → 0.7 and polkadot-api 1.x → 2.x.**

  Aligns the workspace with the latest published `triangle-js-sdks` release line. novasama 0.7 crosses the `polkadot-api 1.x → 2.x` boundary, includes a structural rewrite of `@novasamatech/sdk-statement`'s subscription API, and renames the legacy-account methods on `AccountsProvider`. The PAPI peer-dep bump is itself a breaking change for any consumer pinning to PAPI 1.x.

  ### Catalog version changes

  | Package                          | Before    | After    |
  | -------------------------------- | --------- | -------- |
  | `polkadot-api`                   | `^1.23.3` | `^2.0.2` |
  | `@novasamatech/product-sdk`      | `^0.6.17` | `^0.7.5` |
  | `@novasamatech/sdk-statement`    | `^0.5.0`  | `^0.6.0` |
  | `@novasamatech/host-api`         | `^0.7.0`  | `^0.7.5` |
  | `@parity/host-api-test-sdk`      | `^0.6.0`  | `^0.7.3` |
  | `@polkadot-api/sdk-ink`          | `^0.6.2`  | `^0.7.0` |
  | `@polkadot-api/substrate-client` | `^0.5.0`  | `^0.7.0` |

  A `pnpm.overrides` entry pins `@polkadot-api/json-rpc-provider: ^0.2.0` to work around an upstream packaging bug in `@polkadot-api/json-rpc-provider-proxy@0.4.0` (declares its peer as a `devDependency`, lets the older `0.0.1` from `@substrate/connect`'s tree leak through).

  ### Breaking changes consumers will see

  #### `@parity/product-sdk-host`

  - **`HostStatementStore.subscribe` signature changed.** Was `subscribe(topics: Uint8Array[], callback: (statements: unknown[]) => void)`, now `subscribe(filter: StatementTopicFilter, callback: (page: StatementsPage) => void)`. Filter is structured (`{ matchAll: Topic[] } | { matchAny: Topic[] }`); callback receives pages of statements (`{ statements, isComplete }`) instead of raw arrays.
  - **`StatementProof` variants renamed.** Was `Sr25519 | Ed25519 | Secp256k1Ecdsa | EcdsaRecoverable`, now `Sr25519 | Ed25519 | Ecdsa | OnChain`. `Ecdsa` replaces `Secp256k1Ecdsa`; `EcdsaRecoverable` is gone; `OnChain` is new (chain-attestation-based proof referencing `{ who, blockHash, event }`).
  - **New exported types:** `StatementTopicFilter`, `StatementsPage`, `HostSubscription`.
  - **`AccountsProvider` method rename.** `getNonProductAccounts` → `getLegacyAccounts`, `getNonProductAccountSigner` → `getLegacyAccountSigner`. Public type updated.
  - **`JsonRpcProvider` import path** moved internally from `polkadot-api/ws-provider/web` (gone in PAPI 2.x) to `polkadot-api`. Consumers that imported it the same way should follow.

  #### `@parity/product-sdk-statement-store`

  - Subscription delivery is now page-based at the host boundary. The public `StatementClient.subscribe(callback, opts)` API is unchanged; the per-fire batch sizes may differ from the previous behavior.
  - No more `Secp256k1Ecdsa` / `EcdsaRecoverable` proofs reach `StatementClient` callers — code branching on those variants must handle `Ecdsa` / `OnChain` instead.

  #### `@parity/product-sdk-bulletin`

  - **`Binary.fromBytes` no longer needed.** PAPI 2.x's typed `tx` accepts `Uint8Array` directly. The `Binary` namespace itself dropped `fromBytes` — surface is now `{ toText, toHex, toOpaque, fromText, fromHex, fromOpaque }`. External code that called `Binary.fromBytes(...)` will break at runtime.

  #### Workspace-wide (PAPI 2.x)

  - **`polkadot-api/ws-provider/web` and `/node` subpaths are gone.** Consolidated into `polkadot-api/ws`. Imports targeting the old subpaths fail with `Cannot find module`.
  - **`Binary` namespace shape changed** — removed `fromBytes`, kept `fromText/fromHex/fromOpaque` and the `to*` counterparts.
  - **`JsonRpcProvider` callback shape.** `onMessage` now receives `JsonRpcMessage<any>` instead of `string`. `isResponse` and `isRequest` are now exported from `@polkadot-api/json-rpc-provider`.

  ### Bundle-size impact

  Net win across the board — no tree-shaking regression. Most packages shrank because PAPI 2.x dropped the WASM crypto path and novasama 0.7's accounts surface is leaner.

  | Entry                                                                        |     Bundled Δ |
  | ---------------------------------------------------------------------------- | ------------: |
  | `@parity/product-sdk-host`                                                   |          −11% |
  | `@parity/product-sdk-storage`                                                |          −11% |
  | `@parity/product-sdk-statement-store`                                        |          −11% |
  | `@parity/product-sdk-signer` (and `./wallet`)                                |          −10% |
  | `@parity/product-sdk-keys`                                                   |           −3% |
  | `@parity/product-sdk-tx`                                                     |           −3% |
  | `@parity/product-sdk-bulletin`, `chain-client`, `contracts`, `descriptors/*` | flat to −0.5% |

  Shake ratios held steady or improved across all entries.

  ### Verification

  - `pnpm install` clean, single `polkadot-api@2.0.2` and single `@polkadot-api/json-rpc-provider@0.2.0` in the tree.
  - `pnpm -r build` — all 24 workspace projects build (CJS + ESM + DTS).
  - `pnpm -r test` — 606 unit tests pass across 13 packages.
  - `pnpm test:e2e` — 57 pass, 3 skipped, 0 failed across all 9 demo apps. The 3 skipped tests are permission-rejection tests carrying `TODO(novasama-0.7-upgrade)` markers; novasama 0.7 caches the `TransactionSubmit` grant from initial connect rather than re-checking on each sign, and the test SDK's `revokePermission` no longer reaches the signing path. Re-enable when the test SDK and product-sdk converge on a per-sign permission contract.
  - `pnpm check` (biome) green.

  ### Migration notes for consumers

  1. **If you wrote against `HostStatementStore.subscribe`:** rewrite the call site to pass a `StatementTopicFilter` object and adapt your callback to `(page: StatementsPage) => void`. The page's `isComplete` flag tells you when the initial backfill has finished.
  2. **If you matched on `StatementProof.tag`:** replace `Secp256k1Ecdsa` and `EcdsaRecoverable` cases with `Ecdsa` and `OnChain`. The `OnChain` value shape is `{ who, blockHash, event }` — different from the `{ signature, signer }` shape of the others.
  3. **If you imported anything from `polkadot-api/ws-provider/web` or `/node`:** swap to `polkadot-api/ws`. For `JsonRpcProvider`, importing from top-level `polkadot-api` works cleanly.
  4. **If you used `Binary.fromBytes(data)` to wrap `Uint8Array`s for typed `tx` calls:** drop the wrapper — `Uint8Array` flows through directly.
  5. **If you called `accountsProvider.getNonProductAccounts()` or `getNonProductAccountSigner()`:** rename to `getLegacyAccounts()` and `getLegacyAccountSigner()`.

### Patch Changes

- Updated dependencies [646d591]
- Updated dependencies [646d591]
  - @parity/product-sdk-logger@0.1.1
  - @parity/product-sdk-keys@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-keys@0.1.0
  - @parity/product-sdk-logger@0.1.0
