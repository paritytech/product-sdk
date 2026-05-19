# @parity/product-sdk-bulletin

## 0.4.2

### Patch Changes

- Updated dependencies [4c13257]
- Updated dependencies [4c13257]
  - @parity/product-sdk-descriptors@0.4.1
  - @parity/product-sdk-host@0.4.0
  - @parity/product-sdk-chain-client@0.4.2
  - @parity/product-sdk-tx@0.2.4

## 0.4.1

### Patch Changes

- Updated dependencies [bdeb144]
  - @parity/product-sdk-host@0.3.0
  - @parity/product-sdk-chain-client@0.4.1
  - @parity/product-sdk-tx@0.2.3

## 0.4.0

### Minor Changes

- 1cc3790: **Migrate the `paseo` preset to Paseo Next v2 endpoints and chain instances.**

  Paseo Next v1 is being shut down on 2026-05-20. Per the Paseo team, v2 is the successor — not a parallel network — so the `"paseo"` preset string keeps its name and now points at v2 chains. Consumers calling `getChainAPI("paseo")` get v2 with no code change.

  ### What changed

  - **`@parity/product-sdk-chain-client`**: `rpcs.paseo` swaps to the new endpoints (asset-hub-next, bulletin-next, people-next-system). The retired v1 mirrors (`sys.ibp.network/asset-hub-paseo`, `asset-hub-paseo-rpc.n.dwellir.com`, `paseo-bulletin-rpc.polkadot.io`, `paseo-people-next-rpc.polkadot.io`) are gone.
  - **`@parity/product-sdk-descriptors`**: every paseo subpackage (`paseo-asset-hub`, `paseo-bulletin`, `paseo-individuality`) regenerated against the live v2 RPC. Each descriptor's embedded `genesis` and `codeHash` reflect the v2 chain instance.
  - **`@parity/product-sdk-bulletin`**: `BulletinChain.paseo.genesisHash` literal updated to the v2 bulletin genesis.
  - **`@parity/product-sdk-host`**: `BULLETIN_RPCS.paseo` updated; `DEFAULT_BULLETIN_ENDPOINT` follows since it's `BULLETIN_RPCS.paseo[0]`.

  ### New endpoints

  | Chain                     | URL                                              | Genesis                                                              |
  | ------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
  | Asset Hub Next (1500)     | `wss://paseo-asset-hub-next-rpc.polkadot.io`     | `0x173cea9df45656cf612c8b8ece56e04e9a693c69cfaac47d3628dae735067af8` |
  | Bulletin Next (1501)      | `wss://paseo-bulletin-next-rpc.polkadot.io`      | `0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22` |
  | People Next System (1502) | `wss://paseo-people-next-system-rpc.polkadot.io` | `0x053e1a785bb0990b98768124d9609e963d9ca3558f5ac6e90a4297aaa0a0bd4b` |

  ### Breaking changes

  - Consumers that hardcoded any of the retired v1 RPC URLs must update them.
  - Consumers comparing genesis hashes (e.g. for chain-identity cache keys) will see different values for paseo asset-hub, bulletin, and individuality. The `paseo_asset_hub`, `paseo_bulletin`, and `paseo_individuality` descriptor objects each carry a new `.genesis` value, and `BulletinChain.paseo.genesisHash` is updated.
  - The `paseo-asset-hub` descriptor config switched from polkadot-api chain-spec resolution (`"chain": "paseo_asset_hub"`) to `wsUrl`-based resolution, since the chain spec registry doesn't yet know about v2. No consumer-visible impact — the resulting descriptor module exports the same `paseo_asset_hub` symbol with the same shape.

### Patch Changes

- Updated dependencies [1cc3790]
  - @parity/product-sdk-descriptors@0.4.0
  - @parity/product-sdk-chain-client@0.4.0
  - @parity/product-sdk-host@0.2.2
  - @parity/product-sdk-tx@0.2.2

## 0.3.0

### Minor Changes

- 5d81610: **Add previewnet environment support and split bulletin/individuality descriptors per environment.**

  Previewnet is a zombienet deployment running a Paseo runtime, replacing Paseo Next v1 as the priority test target. This release wires previewnet end-to-end across the SDK and, in the process, restructures bulletin and individuality descriptors to follow the same per-environment resolution pattern already used for asset-hub — so `descriptor.genesis` now matches the live chain instance the consumer connects to.

  ### What's new

  - **`getChainAPI("previewnet")`** routes to the zombienet endpoints at `previewnet.substrate.dev` for asset-hub, bulletin, and people (individuality).
  - **`BulletinChain.previewnet`** preset with the live previewnet bulletin genesis hash.
  - **`BULLETIN_RPCS.previewnet`** in `@parity/product-sdk-host` (additive).
  - **New descriptor packages**: `@parity/product-sdk-descriptors/previewnet-asset-hub`, `/paseo-bulletin`, `/previewnet-bulletin`, `/paseo-individuality`, `/previewnet-individuality`. Each embeds its own genesis hash and metadata blob.

  ### Breaking changes

  - **`@parity/product-sdk-descriptors`**: the shared `/bulletin` and `/individuality` exports are removed. Direct BYOD consumers must migrate:
    - `@parity/product-sdk-descriptors/bulletin` → `@parity/product-sdk-descriptors/paseo-bulletin` (or `/previewnet-bulletin`)
    - `@parity/product-sdk-descriptors/individuality` → `@parity/product-sdk-descriptors/paseo-individuality` (or `/previewnet-individuality`)
    - Named exports change correspondingly: `bulletin` → `paseo_bulletin`, `individuality` → `paseo_individuality`, etc.
  - **`@parity/product-sdk-chain-client`**: `PresetChains<E>` now resolves bulletin and individuality per environment. `ChainClientConfig.rpcs` requires a key for every environment the consumer supplies in `chains`. Consumers using `getChainAPI(env)` are unaffected at the call site — the typed return shape just becomes more precise.
  - **`@parity/product-sdk-bulletin`**: `BulletinNetwork.descriptor` is now `typeof paseo_bulletin | typeof previewnet_bulletin` (was a single type). The existing `BulletinChain.paseo.descriptor` continues to work; callers spreading `...BulletinChain.paseo` are unaffected.

  ### Why split the descriptors

  Bulletin and individuality run identical runtimes on paseo and previewnet today, but each environment is a separate chain deployment with its own genesis block. The previous shared-descriptor model exposed paseo's genesis hash regardless of the live chain — fine for SCALE encoding/decoding (PAPI validates runtime genesis from the live `chainHead`, not the descriptor), but misleading for any consumer using `descriptor.genesis` for chain identity (caching, telemetry, multi-chain dispatch). Per-environment descriptors keep the API surface honest and give us a clean separation point if the runtimes ever diverge.

  ### Endpoints wired

  | Chain                             | URL                                        |
  | --------------------------------- | ------------------------------------------ |
  | Previewnet Asset Hub              | `wss://previewnet.substrate.dev/asset-hub` |
  | Previewnet Bulletin               | `wss://previewnet.substrate.dev/bulletin`  |
  | Previewnet Individuality (People) | `wss://previewnet.substrate.dev/people`    |

  Statement-store routing requires no SDK changes — endpoints flow through the host container (configured in the mobile dev app builds), not our presets.

  ### Side fix

  The `paseo-individuality` descriptor regenerated against the live paseo people-next chain reflects the v1 → v2 redeploy: genesis is now `0xa22a2424...` (was `0xd01475...` in the stale shared descriptor). Consumers querying paseo people-next storage with the old descriptor would have seen schema-level decode mismatches against the v2 runtime.

### Patch Changes

- Updated dependencies [5d81610]
- Updated dependencies [5d81610]
  - @parity/product-sdk-host@0.2.1
  - @parity/product-sdk-descriptors@0.3.0
  - @parity/product-sdk-chain-client@0.3.0
  - @parity/product-sdk-tx@0.2.1

## 0.2.1

### Patch Changes

- 6fc8188: **Fix `checkAuthorization` returning incorrect `remainingTransactions` / `remainingBytes` after the upstream `AuthorizationExtent` rename.**

  `polkadot-bulletin-chain` PR #448 (`e543696`, 2026-04-30) reshaped the on-chain `AuthorizationExtent` struct: `transactions` and `bytes` are now **consumed counters**, and the granted allowance moved to new fields `transactions_allowance` / `bytes_allowance`. The bulletin SDK was still reading `auth.extent.transactions` and `auth.extent.bytes` directly as the remaining quota — meaning every consumer saw the _consumed_ value where it expected _remaining_, so a freshly-authorized account looked like it had `0` left and a fully-consumed one looked unlimited.

  ### What changed

  - `checkAuthorization` now computes `remaining = allowance − consumed` for both transactions and bytes, restoring the public `AuthorizationStatus` contract semantics.
  - Bulletin chain metadata regenerated against the new struct so `auth.extent.transactions_allowance` / `bytes_allowance` are typed at compile time. `@parity/product-sdk-descriptors` patch-bumps to ship the regenerated `bulletin.scale` blob and the matching generated TypeScript.

  No public API changes — `AuthorizationStatus.remainingTransactions` / `remainingBytes` keep the same names and semantics; the on-chain decode path is the only thing that moved.

- Updated dependencies [6fc8188]
  - @parity/product-sdk-descriptors@0.2.1
  - @parity/product-sdk-chain-client@0.2.1

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

- 646d591: **Bulletin: add `authorizeAccount` helper.**

  Adds a top-level `authorizeAccount` function and a matching `BulletinClient.authorizeAccount` class method for granting bulletin-storage authorizations to an account on chain. Pairs with the existing `checkAuthorization` pre-flight helper so consumers can both inspect and grant authorization without dropping to the upstream builder.

  ### New surface — `@parity/product-sdk-bulletin`

  - `authorizeAccount(api, options)` — top-level helper.
  - `BulletinClient.authorizeAccount(options)` — class-method form using the client's bound api.
  - `AuthorizeAccountOptions` — options type re-exported from `@parity/product-sdk-bulletin`.

  Pure addition; no breaking changes.

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
  - @parity/product-sdk-chain-client@0.2.0
  - @parity/product-sdk-descriptors@0.2.0
  - @parity/product-sdk-host@0.2.0
  - @parity/product-sdk-tx@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-chain-client@0.1.0
  - @parity/product-sdk-crypto@0.1.0
  - @parity/product-sdk-host@0.1.0
  - @parity/product-sdk-logger@0.1.0
  - @parity/product-sdk-tx@0.1.0
