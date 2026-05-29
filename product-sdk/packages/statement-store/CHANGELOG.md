# @parity/product-sdk-statement-store

## 0.3.0

### Minor Changes

- 7610e61: **Track upstream rename: `@novasamatech/product-sdk` → `@novasamatech/host-api-wrapper`.**

  Novasama renamed their host-API wrapper package from `@novasamatech/product-sdk` to `@novasamatech/host-api-wrapper`. The first release under the new name is `0.7.9-6` (a prerelease).

  ### What changed for consumers

  If you install `@parity/product-sdk-host`, `@parity/product-sdk-signer`, or `@parity/product-sdk-statement-store` and were previously satisfying their optional peer dependency on `@novasamatech/product-sdk` manually, switch your direct install to `@novasamatech/host-api-wrapper` instead:

  ```diff
  - "@novasamatech/product-sdk": "^0.7.8"
  + "@novasamatech/host-api-wrapper": "0.7.9-6"
  ```

  Same upstream package, same exports (`hostApi`, `createAccountsProvider`, `preimageManager`, `hostLocalStorage`, etc.) — only the npm package name changed.

  If you don't install the peer directly (i.e. your bundle ships without the host-side wrapper), no action needed.

  ### Catalog pin rationale

  The new package is currently only published as `0.7.9-6` (a prerelease). The catalog is pinned to exactly `0.7.9-6` rather than `^0.7.9-6` because prerelease ranges have surprising semver semantics and prereleases can be republished. The pin will move to `^0.7.9` once a stable lands; the catalog auto-bumper (`product-sdk-deps-check.yml`) will pick that up automatically.

  ### Why minor

  Renaming an optional peer dependency is a consumer-visible change: anyone who satisfies our peer manually needs to update their own install. Per `RELEASES.md`'s pre-1.0 convention, that ships as `minor`.

### Patch Changes

- 7610e61: **Bump `@novasamatech/host-api-wrapper` and `@novasamatech/host-api` to `^0.7.9` (stable).**

  `0.7.9` is the first stable release on the `0.7.9` line. The previous catalog pinned the `0.7.9-6` prerelease exactly (no caret); this bump relaxes both entries to `^0.7.9` so the auto-bumper (`product-sdk-deps-check.yml`) can pick up future patch releases automatically.

  No source-level changes for consumers — `0.7.9` is the same API surface as the prereleases we were already shipping against.

- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
  - @parity/product-sdk-host@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [4c13257]
  - @parity/product-sdk-host@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [bdeb144]
  - @parity/product-sdk-host@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [1cc3790]
  - @parity/product-sdk-host@0.2.2

## 0.2.1

### Patch Changes

- 5d81610: **Bump `@novasamatech/product-sdk` and `@novasamatech/host-api` to `^0.7.8`.**

  Picks up the latest novasama patch release. Catalog-pinned (`pnpm-workspace.yaml`), so the three consumer packages — `host`, `signer`, and `statement-store` — pick up the new version transitively. No source changes required in this SDK; the upstream patch is backwards-compatible at the API surface novasama exposes to us.

- Updated dependencies [5d81610]
- Updated dependencies [5d81610]
  - @parity/product-sdk-host@0.2.1

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
  - @parity/product-sdk-utils@0.1.1
  - @parity/product-sdk-host@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-host@0.1.0
  - @parity/product-sdk-logger@0.1.0
  - @parity/product-sdk-utils@0.1.0
