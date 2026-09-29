# @parity/product-sdk-utils

## 0.2.0

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

## 0.1.1

### Patch Changes

- 646d591: **Build + docs cleanup affecting published artifacts.**

  No public API changes. Two improvements that change shipped bytes:

  - `tsup` `treeshake: true` is now enabled across every package's build config (#48), so dead in-source vitest test code is stripped from the published bundles. Smaller install footprint with no behavior change.
  - `@packageDocumentation` blocks and TSDoc comments added across the SDK (#38), surfaced in the published `.d.ts` files for editor hover docs and the docs site.

  Packages already taking a `minor` bump in this release (`bulletin`, `chain-client`, `contracts`, `descriptors`, `host`, `keys`, `signer`, `statement-store`, `tx`, `sdk`) inherit these changes via that bump and are not listed here.

- Updated dependencies [646d591]
  - @parity/product-sdk-logger@0.1.1

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-logger@0.1.0
