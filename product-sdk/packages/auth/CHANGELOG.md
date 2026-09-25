# @parity/product-sdk-auth

## 0.4.1

### Patch Changes

- @parity/product-sdk-keys@0.4.1
- @parity/product-sdk-terminal@0.10.1
- @parity/product-sdk-tx@0.4.11

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
  - @parity/product-sdk-keys@0.4.0
  - @parity/product-sdk-terminal@0.10.0
  - @parity/product-sdk-tx@0.4.10

## 0.3.1

### Patch Changes

- @parity/product-sdk-keys@0.3.26
- @parity/product-sdk-terminal@0.9.1
- @parity/product-sdk-tx@0.4.9

## 0.3.0

### Minor Changes

- a85b489: **Pair with a 0.9.0+ host.** `@novasamatech/host-papp` and its three lockstep siblings move from `^0.8.9` to `0.10.0`.

  The old caret admitted only `>=0.8.9 <0.9.0`. host-papp 0.9.0 changed the pairing envelope from P-256 / AES-GCM to X25519 / ChaCha20-Poly1305 and shrank the encryption keys from 65 bytes to 32, and the handshake codec is fixed-width SCALE, so an SDK on the old pin could not complete a handshake. Both shipping mobile hosts moved to the new envelope in mid-August 2026, so this has been broken in the field since then.

  **Existing paired sessions are invalidated. Users re-pair once.** The persisted session storage key moved `SsoSessionsV3` → `SsoSessionsV4`, so sessions written by an earlier CLI run are not read. `UserSecretsV2_<sessionId>.json` files are left behind but cause no errors, and the `DeviceIdentity` blob is unaffected. Same shape of break as the 0.8.7-1 bump.

  **The on-disk allowance cache is versioned 1 → 2 and stale files are dropped.** Its entries belong to sessions that can no longer exist, and two fields changed shape, so a v1 file is discarded rather than half-read. The first allocation after upgrading is one extra round trip.

  **Breaking, for anyone importing these types directly:**

  - `AllocatableResource` — `SmartContractAllowance`'s payload is now a tagged `{ tag: "Index"; value: number } | { tag: "Raw"; value: Uint8Array }` instead of a bare `number`.
  - `ApAllocationOutcome` — `AutoSigning` drops `productDerivationSecret` and gains `ringVrfDomainEntropy`.
  - `CachedAllocation` — `SmartContractAllowance.dest` is a string (`"Index::7"`, `"Raw::0x…"`), and the `AutoSigning` entry carries `ringVrfDomainEntropy`.

  `ProductAccountRef` is unchanged: the SDK still takes a plain `derivationIndex` and emits the `Index` variant for you.

  **Not taking 0.10.1 or newer.** They raise their `polkadot-api` floor to `>=3` and this workspace is on PAPI 2. 0.10.0 is wire-identical to 0.10.2 for pairing, handshake, signing and resource allocation, so nothing is lost by holding here. A `polkadot-api` override keeps host-papp's open `>=2` range from pulling a second PAPI copy into the graph.

  **This restores pairing, not phone-paired signing.** Product-account derivation in `@parity/product-sdk-keys` predates RFC-0022 and does not match any current host, so a signature still carries the wrong address. That is a separate, pre-existing defect, tracked on its own.

### Patch Changes

- Updated dependencies [a85b489]
- Updated dependencies [a85b489]
- Updated dependencies [a85b489]
  - @parity/product-sdk-terminal@0.9.0
  - @parity/product-sdk-keys@0.3.25
  - @parity/product-sdk-tx@0.4.8

## 0.2.10

### Patch Changes

- @parity/product-sdk-keys@0.3.24
- @parity/product-sdk-terminal@0.8.2
- @parity/product-sdk-tx@0.4.7

## 0.2.9

### Patch Changes

- Updated dependencies [d0260a1]
  - @parity/product-sdk-terminal@0.8.1
  - @parity/product-sdk-keys@0.3.23
  - @parity/product-sdk-tx@0.4.6

## 0.2.8

### Patch Changes

- Updated dependencies [84134e0]
- Updated dependencies [84134e0]
  - @parity/product-sdk-terminal@0.8.0
  - @parity/product-sdk-keys@0.3.22
  - @parity/product-sdk-tx@0.4.5

## 0.2.7

### Patch Changes

- Updated dependencies [46e3592]
  - @parity/product-sdk-terminal@0.7.4
  - @parity/product-sdk-keys@0.3.21
  - @parity/product-sdk-tx@0.4.4

## 0.2.6

### Patch Changes

- f987fd7: **Account to username: `lookupUsername` reads `Resources.Consumers` (#302).**

  The SDK could answer "who owns username X" and not the direction products actually need on a results
  or profile screen: "what is this account's username". `lookupUsername(chain, { account })` answers it
  from `Resources.Consumers`, which is keyed by account and carries both names plus the credibility.
  Two apps and the host's own Rust core each hand-rolled this decode; this replaces all three.

  ```ts
  const result = await lookupUsername(chain, { account: rootAddress });
  if (result.ok && result.value) console.log(displayUsername(result.value));
  ```

  **An account with no consumer record is `ok(null)`, not an error.** The chain was asked and answered.
  Everything that can genuinely fail arrives on the `err` channel as a `ProductIndividualityError`,
  with `IndividualityDecodeError` for a shape the descriptor says is impossible.

  The record is `{ liteUsername, fullUsername, credibility }`, plus three pure helpers:
  `displayUsername` (the claimed name, else the lite one), `canClaimFullUsername`, and `usernameBase`.
  The read pins no block by default: it reads the finalized head at call time and reports no block
  back, so pass `at` a `readPersonhoodState` result's `at.blockHash` when both answers must describe
  the same block.

  Four properties come from the pallet rather than from the descriptor, and none is visible to the
  compiler:

  - **A lite username is always present and always `<letters>.<digits>`**; a full username is letters
    only, with no dot.
  - **`fullUsername === null` is the chain's own precondition for claiming a bare name**, which is what
    `canClaimFullUsername` reports. The chain writes `full_username` and `Credibility::Person` in the
    same statement, so "has a full name" and "is a person" are equivalent by construction.
  - **A demoted person keeps `Person` and keeps their full username.** Demotion rewrites only that
    flag, so nothing else in the record separates a demoted person from the rest. `demoted: false` is
    a weaker statement than it looks, though: the chain sets the flag only when somebody submits
    `demote_auth_expired`, and nothing submits it automatically, so it also covers a person whose
    authorization expired and who has not been demoted yet. `credibility.lastUpdate` is surfaced for
    exactly that: seconds since the epoch, as a `number`, to compare against the chain's
    `PersonAuthDuration` and tell a current authorization from a stale one. This package does not read that constant, so it hands back the timestamp rather
    than a verdict.
  - **An empty username is a decode error**, in both fields, and a name that is not valid UTF-8 fails
    loudly rather than becoming U+FFFD. Empty is impossible on chain, and reading an empty full
    username as absent would make `canClaimFullUsername` offer a claim the chain rejects, since
    `Some("")` is still `Some`.

  `displayUsername` is the same rule the host applies for `account.getUserId().primaryUsername`, so for
  the signed-in user the two should agree and a disagreement means a stale session snapshot.

  The chain parameter is typed structurally as `ConsumersChain`, so anything with the storage shape
  satisfies it, including a test double. A compile-time assertion in `@parity/product-sdk` checks a real
  `getChainAPI` client still satisfies it, so a descriptor regeneration that changes the entry fails
  `pnpm typecheck` rather than failing at runtime in a product.

  **Breaking, and the reason for the minor: `resolvePeopleUsernameOwner` now returns `SS58String`
  rather than `0x` hex.** It reads storage that yields SS58, and `Resources.Consumers` is keyed by
  SS58, so the old hex return made every account to username round trip carry a manual conversion.
  `wallet.signMessageWithDotNsIdentity` is unaffected: its `accountId` result is still `0x` hex.
  Callers who relied on the hex return get `accountIdToHex`, newly exported from
  `@parity/product-sdk/identity`, which is the inverse of the existing `accountIdHexToBytes` and keeps
  the same 32-byte check.

  `@parity/product-sdk-auth` gets a documentation fix only. Its `SessionAddresses.rootAddress` doc, and
  the `product-sdk-transactions` skill that repeats it, both told callers `rootAddress` was "the right
  input for `lookupUsername`" while no such function existed anywhere in the repo. Both now name the
  package it lives in.

  Re-exported from the umbrella as `@parity/product-sdk/individuality`. Documented by the
  `product-sdk-individuality` skill.

- Updated dependencies [f987fd7]
  - @parity/product-sdk-address@0.2.0
  - @parity/product-sdk-terminal@0.7.3
  - @parity/product-sdk-keys@0.3.20
  - @parity/product-sdk-tx@0.4.3

## 0.2.5

### Patch Changes

- @parity/product-sdk-terminal@0.7.2
- @parity/product-sdk-keys@0.3.19
- @parity/product-sdk-tx@0.4.2

## 0.2.4

### Patch Changes

- @parity/product-sdk-keys@0.3.18
- @parity/product-sdk-terminal@0.7.1
- @parity/product-sdk-tx@0.4.1

## 0.2.3

### Patch Changes

- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
  - @parity/product-sdk-terminal@0.7.0
  - @parity/product-sdk-tx@0.4.0
  - @parity/product-sdk-keys@0.3.17

## 0.2.2

### Patch Changes

- @parity/product-sdk-keys@0.3.16
- @parity/product-sdk-terminal@0.6.2
- @parity/product-sdk-tx@0.3.2

## 0.2.1

### Patch Changes

- @parity/product-sdk-keys@0.3.15
- @parity/product-sdk-terminal@0.6.1
- @parity/product-sdk-tx@0.3.1

## 0.2.0

### Minor Changes

- cb0098f: Add `@parity/product-sdk-auth` — the QR/mobile sign-in + session-signing glue, lifted from playground-cli's `src/utils/{auth,signer,sessionSigner}.ts` plus the RFC-0010 allocation helper, and refactored so all env config (dApp id, product id, derivation index, People endpoints) is injected via `createAuthClient(config)` rather than imported from a product's own `config.ts`. One shared sign-in implementation for playground-cli, bulletin-deploy, and future product CLIs.

  **Public API:** `createAuthClient` / `resolveSigner` / RFC-0010 `requestResourceAllocation`, plus a `./ui` subpath (QR render + login/logout status formatters). The headless root pulls in no terminal-render code.

### Patch Changes

- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
  - @parity/product-sdk-terminal@0.6.0
  - @parity/product-sdk-tx@0.3.0
  - @parity/product-sdk-keys@0.3.14
