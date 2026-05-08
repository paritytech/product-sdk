# @parity/product-sdk

## 0.2.0

### Minor Changes

- 646d591: **Bulletin: wrap `@parity/bulletin-sdk` for chunked uploads + on-chain verification.**

  `BulletinClient` now wraps upstream `AsyncBulletinClient`, gaining native chunking (>2 MiB), DAG-PB manifests, and progress events. Uploads sign and submit a `TransactionStorage.store` extrinsic; reads go through the host's preimage subscription (container-only, matching PR #26's stance — no public-gateway fetches); CID-on-chain verification is exposed via a new helper.

  ### Breaking changes — `@parity/product-sdk-bulletin`

  | Before                                                              | After                                                                                                  |
  | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
  | `BulletinClient.create("paseo")`                                    | `BulletinClient.create({ environment: "paseo", signer })` — signer is now required                     |
  | `BulletinClient.from(api)`                                          | `BulletinClient.from(inner, api)` — pass a pre-built `AsyncBulletinClient`                             |
  | `bulletin.upload(data, signer?)`                                    | `await bulletin.store(data).send()`                                                                    |
  | `bulletin.batchUpload([...])`                                       | Loop `for (const item of items) await bulletin.store(item.data).send()` (upstream has no batch helper) |
  | `result.kind === "preimage" \| "transaction"` (discriminated union) | `result: StoreResult` from upstream (`{ cid?, size, blockNumber?, extrinsicIndex?, chunks? }`)         |
  | `computeCid(data)` (sync)                                           | `await calculateCid(data)` (async — uses Web Crypto)                                                   |
  | `import { computeCid }`                                             | `import { calculateCid }` (re-exported from upstream)                                                  |

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
- Updated dependencies [646d591]
- Updated dependencies [646d591]
  - @parity/product-sdk-address@0.1.1
  - @parity/product-sdk-crypto@0.1.1
  - @parity/product-sdk-logger@0.1.1
  - @parity/product-sdk-storage@0.1.1
  - @parity/product-sdk-bulletin@0.2.0
  - @parity/product-sdk-chain-client@0.2.0
  - @parity/product-sdk-contracts@0.2.0
  - @parity/product-sdk-host@0.2.0
  - @parity/product-sdk-keys@0.2.0
  - @parity/product-sdk-signer@0.2.0
  - @parity/product-sdk-tx@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-address@0.1.0
  - @parity/product-sdk-bulletin@0.1.0
  - @parity/product-sdk-chain-client@0.1.0
  - @parity/product-sdk-contracts@0.1.0
  - @parity/product-sdk-crypto@0.1.0
  - @parity/product-sdk-host@0.1.0
  - @parity/product-sdk-keys@0.1.0
  - @parity/product-sdk-logger@0.1.0
  - @parity/product-sdk-signer@0.1.0
  - @parity/product-sdk-storage@0.1.0
  - @parity/product-sdk-tx@0.1.0
