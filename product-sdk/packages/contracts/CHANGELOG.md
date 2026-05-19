# @parity/product-sdk-contracts

## 0.5.0

### Minor Changes

- bdeb144: **Surface the failure payload on `QueryResult.value`.**

  A failed contract query used to return `{ success: false, value: undefined, gasRequired: undefined }` — callers had no way to tell _why_ the dry-run failed. Was the contract reverting? Was the caller account unmapped? Did the call decode at all? Diagnosing it meant reaching past the SDK with manual storage probes, even though the runtime had already reported the reason on the way back.

  `QueryResult<T>` is now a discriminated union:

  ```ts
  type QueryResult<T> =
    | { success: true; value: T; gasRequired: Weight }
    | { success: false; value: unknown; gasRequired?: Weight };
  ```

  - **Success branch** — `gasRequired` is now guaranteed non-optional (was `Weight | undefined`).
  - **Failure branch** — `value` carries the dispatch-error payload `pallet-revive` returned. Typically narrows as a tagged enum (`{ type: "Module", value: ... }`, `{ type: "ContractReverted" }`, `{ type: "AccountNotMapped" }` — see the Revive pallet error variants). `gasRequired` stays populated when the runtime reported a weight; it's optional because some failure modes don't carry one.

  ### Breaking changes

  Type-level only. Runtime behavior on the success path is unchanged.

  - Reading `.value` without first narrowing on `.success` now produces a TypeScript error — the failure branch widens it to `unknown`. The old type let this compile, but `.value` was `undefined` at runtime on failure, so any read outside an `if (success)` branch was already a latent bug.
  - Constructing a `QueryResult<T>` literal in user code (mocks, tests) now requires `gasRequired` on the success branch.
  - `QueryResult` is a `type` alias, not an `interface` — declaration merging no longer works.

  ### Migration

  If your code reads `r.value` without first checking `if (r.success)`, add the narrowing. Code that was already narrowing keeps working unchanged.

  ```ts
  // Before — compiled, but `r.value` was `undefined` at runtime on failure:
  const r = await contract.query.foo();
  processResponse(r.value);

  // After:
  const r = await contract.query.foo();
  if (r.success) {
    processResponse(r.value);
  } else {
    // r.value is `unknown` — narrow on the dispatch-error shape:
    if (
      typeof r.value === "object" &&
      r.value !== null &&
      "type" in r.value &&
      r.value.type === "ContractReverted"
    ) {
      handleRevert();
    } else {
      handleOtherFailure(r.value);
    }
  }
  ```

### Patch Changes

- @parity/product-sdk-signer@0.2.4
- @parity/product-sdk-keys@0.2.3
- @parity/product-sdk-tx@0.2.3

## 0.4.0

### Minor Changes

- 1cc3790: **Contracts: migrate to `pallet-revive` direct + viem ABI codec; drop `@polkadot-api/sdk-ink`.**

  Drops `@polkadot-api/sdk-ink` for PolkaVM contracts built with `cargo pvm-contract`. Extrinsics + storage go through PAPI's typed API; the `ReviveApi.call` dry-run is routed through `client.getUnsafeApi()` to absorb descriptor-vs-chain compat-token drift.

  ### New surface

  - `createContractRuntimeFromClient(client, descriptor)` — production factory; routes dry-run through the unsafe API.
  - `createContractRuntime(typedApi)` — test factory using the typed API end-to-end.
  - `ContractManager.fromClient(cdm, client, descriptor, options)` + `ContractManager.getRuntime()`.
  - `ensureContractAccountMapped(runtime, address, signer, options?)` — idempotent app-boot helper for the SS58 ↔ H160 mapping `pallet-revive` requires.
  - `ContractDryRunFailedError` — thrown by `.tx()` when the pre-flight dry-run fails, before signing.
  - `/pvm` subpath: `parsePvmContractAbi`, `loadPvmContractAbi`, `loadPvmContractCode`, `loadPvmContractArtifacts`.
  - `/codegen` subpath: `ContractTypeInput`, `resolveContractTypeInputs`, `generateContractTypes`.
  - `.prepare()` on every contract method returns a `BatchableCall` consumable by `batchSubmitAndWatch` from `@parity/product-sdk-tx`.

  ### Breaking changes

  - `@polkadot-api/sdk-ink` and its exports (`createInkSdk`, `InkSdk`, ink!-flavoured types) are removed. Consumers migrate via `createContractRuntime(typedApi)` or `ContractManager.fromClient(cdm, client, descriptor)`.
  - `ReviveCallTx` / `ReviveTypedApi` use `HexString` for `dest` and `Uint8Array` for `data` (PAPI 2.x). Class-based `FixedSizeBinary<20>` / `Binary` are no longer accepted.
  - Codegen output for Solidity `bytes` and `bytesN` aligns with PAPI 2.x: `bytes → HexString`, `bytesN → SizedHex<N>` (was `Binary` / `FixedSizeBinary<N>`). Re-run `cdm install` after upgrading to regenerate user-facing types.
  - Node-only loaders + build-time codegen live on the `/pvm` and `/codegen` subpaths and are not re-exported from the main entry — keeps `fs`/`path`/`os` dynamic imports out of browser bundles that only need `ContractManager`.

  ### Bundle impact

  Consumer ship-size drops from ~750 KB gzip (with `@polkadot-api/sdk-ink`) to ~73 KB gzip — about a 90% reduction for downstream consumers.

### Patch Changes

- @parity/product-sdk-signer@0.2.3
- @parity/product-sdk-keys@0.2.2
- @parity/product-sdk-tx@0.2.2

## 0.2.2

### Patch Changes

- Updated dependencies [5d81610]
  - @parity/product-sdk-signer@0.2.2
  - @parity/product-sdk-keys@0.2.1
  - @parity/product-sdk-tx@0.2.1

## 0.2.1

### Patch Changes

- 6fc8188: **Add `.prepare()` for batching contract calls.**

  Each method on a `Contract<C>` handle now exposes a `.prepare()` companion to `.tx()` that returns a `BatchableCall` consumable by `batchSubmitAndWatch` from `@parity/product-sdk-tx`. Lets consumers group multiple contract calls (or contract calls mixed with other transactions on the same chain) into a single atomic `Utility.batch_all` extrinsic.

  ```ts
  import { batchSubmitAndWatch } from "@parity/product-sdk-tx";

  const a = contract.transfer.prepare(addr1, 100n);
  const b = contract.transfer.prepare(addr2, 200n);
  await batchSubmitAndWatch([a, b], api, signer);
  ```

  `PrepareOptions` is a subset of `TxOptions` — accepts `origin`, `value`, `gasLimit`, `storageDepositLimit`. Signer and submission lifecycle options (`signer`, `waitFor`, `timeoutMs`, `mortalityPeriod`, `onStatus`) are intentionally absent — those belong to the batch submission, not the individual prepared call.

  `prepare()` doesn't require a signer: the resolved origin is used purely for dry-run gas estimation, and the batch submission's signer replaces it as the dispatched origin at submission time.

  Ports the `polkadot-apps` commit `4b60d19` ("feat(contracts): add `.prepare()` for batching contract calls") that never made it into this monorepo.

  ### New surface

  - `Contract<C>[K]["prepare"]` method on every wrapped ABI function.
  - `PrepareOptions` interface — re-exported from `index.ts`.
  - `BatchableCall` re-exported from `@parity/product-sdk-tx` through `index.ts` (single source of truth, matches the source).

  ### Type fix

  - `CdmJsonContract.metadataCid` is now **optional**. Real-world cdm.json files (e.g. `paritytech/playground-cli/cdm.json`) often omit it, and the runtime never reads it — only `version`, `address`, and `abi` are load-bearing for `getContract()`. This unblocks consumers whose cdm.json doesn't include a metadata CID.

  Pure addition; no breaking changes.

- Updated dependencies [6fc8188]
  - @parity/product-sdk-signer@0.2.1

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
  - @parity/product-sdk-signer@0.2.0
  - @parity/product-sdk-tx@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-keys@0.1.0
  - @parity/product-sdk-logger@0.1.0
  - @parity/product-sdk-signer@0.1.0
  - @parity/product-sdk-tx@0.1.0
