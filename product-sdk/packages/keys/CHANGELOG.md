# @parity/product-sdk-keys

## 0.5.0

### Minor Changes

- dde3b0d: **Moves the SDK to polkadot-api 3.** Breaking for every caller that signs.

  PAPI 3 replaced the `PolkadotSigner` with a `TxCreator`, which receives one payload holding the call, every transaction extension, the pipeline version those extensions belong to, and the runtime metadata. Every signer the SDK builds or accepts is now a `CommonSignerTxCreator` from `@polkadot-api/signers-common`: `getProductAccountSigner` and `getLegacyAccountSigner` in host, `SignerManager.getSigner`, `seedToAccount` and the key manager in keys, `createDevSigner` in tx, the session, slot-account and allowance signers in terminal, and the signers `resolveSigner` returns in auth. `submitAndWatch`, `batchSubmitAndWatch` and contract calls take it unchanged. A PAPI transaction is now submitted with `createSubmitAndWatch` or `createAndSubmit`, fees are estimated with a creator such as `getFakeTxCreator(address)`, and the transaction events `signed` and `txBestBlocksState` are now `created`, `inBestBlock` and `notInBestBlock`. The `TxEvent` type in tx follows.

  `withAsPerson`, `withLiteAlias` and `withScoreParticipant` now wrap a `TxCreator`. They fill the standard extensions with the PAPI 3 enhancers, write their origin extension, and hand the inner signer the pipeline version that carries it, so the host is told the version the proof was built for instead of inferring one. This replaces the slot filling that worked around PAPI 2 only knowing pipeline version 0. A fee estimate through a wrapper is priced as a plain account transaction and never requests a proof.

  Host exports `createHostTxCreator`, also published as the transport-free subpath `@parity/product-sdk-host/tx-creator`, which terminal uses for the paired-phone signer. The `txExtVersion` signer option is now the version used when the transaction names none.

  Terminal moves to `@novasamatech/host-papp`, `statement-store` and `storage-adapter` 0.12.0, and host to `@novasamatech/host-api-wrapper` 0.12.0, the releases built for PAPI 3. `@novasamatech/statement-store` 0.12.0 still depends on `@novasamatech/sdk-statement` 0.6.0, which pulls a private copy of polkadot-api 2 into the install. The descriptors are regenerated with the PAPI 3 CLI.

  Cloud Storage keeps working with `@parity/bulletin-sdk` 0.3.0 through a shim that maps its `signSubmitAndWatch` onto `createSubmitAndWatch`, to be removed when a PAPI 3 build ships.

  The `paseo-asset-hub` and `previewnet-asset-hub` descriptors follow `next-asset-hub-paseo` 3004000, and `previewnet-asset-hub` takes the new genesis of the reset Previewnet Asset Hub. That runtime drops the `Result` wrapper from `ScarcityApi.metadata_batch` and `NftClaimsApi.preview_mints`, which now return their list directly and reject an oversized batch at decode (128 queries for `metadata_batch`, 32 for `preview_mints` on `next-asset-hub-paseo` 3004000). `NftsChain` and `NftsInstancesChain` follow, so a hand-built chain answers those calls with a bare list. `getInstanceDisplays` no longer re-chunks on a `TooLarge` refusal, and `previewClaim` sends one `preview_mints` call per 32 collections, the bound the runtime enforces.

  Every nfts read now holds the blocks it pins until it settles, through the optional `hodlBlock` that `BlockSource` gains and a PAPI client already has. A finalized block was unpinned as soon as a newer one was finalized, so a read that spanned that moment failed inside a container with "is not pinned", because the host serves no archive methods to fall back to.

### Patch Changes

- Updated dependencies [dde3b0d]
  - @parity/product-sdk-address@0.3.0
  - @parity/product-sdk-local-storage@0.3.16
  - @parity/product-sdk-utils@0.2.1

## 0.4.3

### Patch Changes

- @parity/product-sdk-local-storage@0.3.15

## 0.4.2

### Patch Changes

- @parity/product-sdk-local-storage@0.3.14

## 0.4.1

### Patch Changes

- @parity/product-sdk-local-storage@0.3.13

## 0.4.0

### Minor Changes

- a0fcb48: **Product accounts derive the RFC-0022 way.** The previous derivation predated RFC-0022 and matched no shipping host, so every product-account address the SDK produced was wrong. It failed closed: the wallet resolves an account selector rather than a key, so it signed as the correct account, but the wrong key drove the nonce lookup and everything else PAPI computes around the signature, and it is the address `packages/auth` displayed.

  A product account sits at `//product//{productId}/{derivationIndex}`. The two `//product//{productId}` junctions are **hard**. Hard junctions cannot be reproduced from a public key, so the old approach — three soft junctions from `session.rootAccountId` — could not have been right for any host. The subtree public key must come from the Account Holder.

  Canonical implementation is `host_logic/product_account.rs` in host-rust-core, mirrored by Android `DerivationPaths.kt` and iOS `DerivationIndex32.swift`. `packages/keys/src/product-account.test.ts` now pins the derivation against the host's own cross-host vector from `truapi-server/tests/wasm_crypto_vectors.rs`, rather than against fixtures generated from our own implementation.

  **Every product-account address changes.** Anything keyed to an address this SDK derived before — funds, allowances, statement-store entries, on-chain registrations — belongs to an account no host will sign for and is stranded. Check before upgrading.

  **Breaking API changes:**

  - `deriveProductAccountPublicKey(productSubtreePublicKey, derivationIndex)` replaces `(parentPublicKey, productId, derivationIndex)`. The index is now a tagged `DerivationIndex` (`{ tag: "Index", value }` or `{ tag: "Raw", value }`), matching the host's own selector.
  - `createChainCode` is **removed**. It encoded junctions that are now hard, and the SDK never derives a hard junction from a public key.
  - `createSessionSigner`, `createSessionSignerForAccount` and `deriveProductPublicKey` return promises. Add `await`.
  - All three, plus the new `getProductSubtreePublicKey`, take an optional trailing `ProductSubtreeOptions` (`{ appId?, storageDir? }`) to relocate the cache.

  **The first derivation per product costs one round trip to the paired wallet.** `session.getProductSubtree(productId)` is consent-free, so it raises no dialog, but it does need the phone reachable. The result is cached in memory and on disk (`{appId}_ProductSubtrees.json`, mode 0600, keyed by session and product), so only a cold cache reaches the wallet. Pass `ProductAccountRef.publicKey` to skip the fetch entirely, or call `getProductSubtreePublicKey` up front to warm the cache before going offline.

  There is deliberately no fallback to the old derivation, or to the wallet's selected account, when the fetch fails: both produce a valid signature over the wrong address, which is the defect being fixed.

  **New in `@parity/product-sdk-utils`:** `derivationIndexBytes(index)` and the `DerivationIndex` type — the RFC-0022 32-byte selector expansion, now shared instead of written once per package. `@parity/product-sdk-individuality`'s `contextSuffixBytes` delegates to it, and is unchanged for callers: same `ContextSuffix` type, same `ProductIndividualityError`, same message text.

  Requires `@novasamatech/host-papp` 0.10.0 or later for `getProductSubtree`.

### Patch Changes

- Updated dependencies [a0fcb48]
  - @parity/product-sdk-utils@0.2.0
  - @parity/product-sdk-local-storage@0.3.12

## 0.3.26

### Patch Changes

- @parity/product-sdk-local-storage@0.3.11

## 0.3.25

### Patch Changes

- @parity/product-sdk-local-storage@0.3.10

## 0.3.24

### Patch Changes

- @parity/product-sdk-local-storage@0.3.9

## 0.3.23

### Patch Changes

- @parity/product-sdk-local-storage@0.3.8

## 0.3.22

### Patch Changes

- @parity/product-sdk-local-storage@0.3.7

## 0.3.21

### Patch Changes

- @parity/product-sdk-local-storage@0.3.6

## 0.3.20

### Patch Changes

- Updated dependencies [f987fd7]
  - @parity/product-sdk-address@0.2.0

## 0.3.19

### Patch Changes

- @parity/product-sdk-local-storage@0.3.5

## 0.3.18

### Patch Changes

- @parity/product-sdk-local-storage@0.3.4

## 0.3.17

### Patch Changes

- @parity/product-sdk-local-storage@0.3.3

## 0.3.16

### Patch Changes

- @parity/product-sdk-local-storage@0.3.2

## 0.3.15

### Patch Changes

- @parity/product-sdk-local-storage@0.3.1

## 0.3.14

### Patch Changes

- Updated dependencies [cb0098f]
  - @parity/product-sdk-local-storage@0.3.0

## 0.3.13

### Patch Changes

- @parity/product-sdk-local-storage@0.2.12

## 0.3.12

### Patch Changes

- @parity/product-sdk-local-storage@0.2.11

## 0.3.11

### Patch Changes

- 8dd1232: chore(deps): bump polkadot-api to 2.1.6

  Updates the `polkadot-api` catalog entry `^2.1.5` → `^2.1.6` (2.1.6 carries the
  double-notification fix). Every published package resolves `polkadot-api`
  through `catalog:`, so each one's published `dependencies` range moves to
  `^2.1.6`. There is no source change in any package — these are patch bumps to
  ship the new floor via the published `catalog:` resolution.

  Releases the catalog bump from #223, which was merged to `main` without a
  changeset.

  - @parity/product-sdk-local-storage@0.2.10

## 0.3.10

### Patch Changes

- @parity/product-sdk-local-storage@0.2.9

## 0.3.9

### Patch Changes

- @parity/product-sdk-local-storage@0.2.8

## 0.3.8

### Patch Changes

- @parity/product-sdk-local-storage@0.2.7

## 0.3.7

### Patch Changes

- @parity/product-sdk-local-storage@0.2.6

## 0.3.6

### Patch Changes

- @parity/product-sdk-local-storage@0.2.5

## 0.3.5

### Patch Changes

- @parity/product-sdk-local-storage@0.2.4

## 0.3.4

### Patch Changes

- @parity/product-sdk-local-storage@0.2.3

## 0.3.3

### Patch Changes

- dc3a452: Bump shared catalog dependencies to their latest within range. Dependency-range updates only; no public API changes:

  - `polkadot-api` `^2.1.2` → `^2.1.5` (all packages listed)
  - `@polkadot-labs/hdkd-helpers` `^0.0.27` → `^0.0.30` (contracts, keys, tx)
  - `viem` `^2.46.2` → `^2.52.0` (contracts)
  - `@novasamatech/host-api` & `@novasamatech/host-api-wrapper` `^0.8.0` → `^0.8.3` (signer's optional deps; host/statement-store carry them as dev-only/unchanged peers)
  - @parity/product-sdk-local-storage@0.2.2

## 0.3.2

### Patch Changes

- @parity/product-sdk-local-storage@0.2.1

## 0.3.1

### Patch Changes

- Updated dependencies [7610e61]
  - @parity/product-sdk-local-storage@0.2.0

## 0.3.0

### Minor Changes

- 4c13257: **Add `deriveProductAccountPublicKey` + `createChainCode` to `@parity/product-sdk-keys`.**

  The canonical sr25519 product-account derivation used by polkadot-desktop
  (`polkadot-desktop/src/domains/product/account/service.ts`) and
  polkadot-app-android-v2
  (`feature/products/impl/.../ProductAccountDerivationUseCase.kt`) is now
  exposed from the SDK. External clients (CLI, web hosts) can compute the
  same derived address the mobile wallet derives privately, without ever
  seeing the secret key. sr25519 soft derivation is composable on the
  parent _public_ key alone.

  ### New surface

  ```ts
  import {
    createChainCode,
    deriveProductAccountPublicKey,
  } from "@parity/product-sdk-keys";

  // Canonical product-account derivation: junctions ["product", productId, "<index>"]
  const derivedPubKey = deriveProductAccountPublicKey(
    parentPublicKey, // Uint8Array, 32-byte sr25519 public key
    "playground.dot", // productId, typically a dotNS name
    0 // derivationIndex
  );

  // Lower-level helper if you need to build custom junction paths:
  const chainCode = createChainCode("product"); // Uint8Array(32)
  ```

  `createChainCode(code)` encodes a junction the way Substrate does:

  - numeric `^\d+$` to SCALE `u64` (BigInt), zero-padded to 32 bytes
  - string to SCALE `str` (compact-length + UTF-8), zero-padded to 32 bytes
  - if the encoded form exceeds 32 bytes, `blake2b256(encoded)`

  `deriveProductAccountPublicKey(parentPubKey, productId, index)` applies
  `HDKD.publicSoft` left-to-right over the junctions `["product",
productId, String(index)]`. Returns the derived 32-byte public key.

  ### Cross-platform parity note

  `productId` MUST contain at least one non-hex character OR be of odd
  length when serialized as a string. polkadot-app-android-v2's
  `SubstrateJunctionDecoder` tries to interpret a junction as hex BEFORE
  falling through to SCALE-string encoding; polkadot-desktop and this
  implementation skip that hex branch. For productIds that happen to be
  even-length all-hex strings (e.g. `"deadbeef"`, `"c0ffee01"`), Android
  would derive a different public key. In practice, productIds are dotNS
  names like `"playground.dot"`, which contain `.` and never trip the hex
  branch.

  ### Frozen vectors

  Output is locked by four byte-for-byte test vectors in
  `packages/keys/src/product-account.test.ts`, covering the production case
  (`playground.dot`/0), the non-zero u64 numeric branch, a near-boundary
  productId, and the blake2b fallback. Parent public keys in the vectors
  are derived from deterministic 32-byte seeds via `@scure/sr25519`'s
  `secretFromSeed` + `getPublicKey` (arbitrary 32-byte buffers do not work:
  `HDKD.publicSoft` validates the Ristretto255 encoding at the entry
  point). If polkadot-desktop's derivation algorithm ever changes, run
  `packages/keys/scripts/regenerate-fixtures.ts` to re-confirm parity and
  update the vectors.

  ### Internal: `@noble/hashes` consolidated on ^2.2.0

  `@parity/product-sdk-keys` now depends on `@scure/sr25519@^2.2.0` and
  `scale-ts@^1.6.1`. The workspace is also consolidated on
  `@noble/hashes@^2.2.0` across `-address`, `-crypto`, `-terminal`, and
  `-utils` to keep a single hash-library version in the dep tree.
  Consumers see no public-API change from the noble bump (one source
  file in `-address` adjusted an import path from `@noble/hashes/sha3` to
  `@noble/hashes/sha3.js`; the extensionless form worked on noble 1.x but
  noble 2.x's package exports require the explicit `.js` suffix).

  No breaking changes here. Purely additive.

### Patch Changes

- @parity/product-sdk-storage@0.1.5

## 0.2.3

### Patch Changes

- @parity/product-sdk-storage@0.1.4

## 0.2.2

### Patch Changes

- @parity/product-sdk-storage@0.1.3

## 0.2.1

### Patch Changes

- @parity/product-sdk-storage@0.1.2

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
  - @parity/product-sdk-address@0.1.1
  - @parity/product-sdk-crypto@0.1.1
  - @parity/product-sdk-storage@0.1.1

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-address@0.1.0
  - @parity/product-sdk-crypto@0.1.0
  - @parity/product-sdk-local-storage@0.1.0
