# @parity/product-sdk-keys

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
  - @parity/product-sdk-storage@0.1.0
