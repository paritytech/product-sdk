# @parity/product-sdk-statement-store

## 0.4.6

### Patch Changes

- acb2228: **Bump `@novasamatech/host-api` family from `^0.8.7-2` to `^0.8.7` (stable).**

  Stable `0.8.7` is now published across the family (`host-api`, `host-api-wrapper`, `host-papp`, `statement-store`, `storage-adapter`, `substrate-slot-sr25519-wasm`). This bump removes the prerelease specifier from the published artifact — consumers see a cleaner semver range and get the same upstream code we've been testing against.

  ### Delta vs `0.8.7-2`

  - **`MAX_SSO_REQUEST_SIZE` raised** in `host-papp`: 256 KiB → 500 KiB. Larger Mobile-SSO statements now flow without splitting.
  - **`ExpiryTooLowError` / `AccountFullError` constructors** in `statement-store` accept `bigint` instead of `number`. Internal — our code doesn't construct these directly.
  - **New additive exports** in `statement-store`: `PRIORITY_EPOCH_OFFSET`, `createExpiryAllocator`, `ExpiryAllocator`, `submitWithRetry`, `isPriorityTooLow`, `SubmitRetryOptions`, `signAndSubmitStatement`, `submitStatementOnce`, `SubmitStatementParams`. Not consumed by product-sdk; opt-in for downstream callers.
  - **No session/secrets codec changes.** The `testing.ts` codec mirror in `@parity/product-sdk-terminal` continues to round-trip through the real `SsoSessionManager` and `UserSecretRepository` against 0.8.7 — both interop tests pass.

  No public API change on the product-sdk side; no migration needed.

- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
  - @parity/product-sdk-host@0.10.0

## 0.4.5

### Patch Changes

- 2124e02: **Bump `@novasamatech/host-api` family from `^0.8.6` to `^0.8.7-2`.** Picks up the upstream `deviceEncPubKey` addition on the V2 session schema (PR #212), the statement-store allowance-slot-prover fix (PR #214 — `createSr25519Prover` → `createSlotAccountProver`), and the `ExpiryTooLow` retry fix in `submitWithRetry`.

  One consumer-visible behavioral change worth flagging up front:

  > **CLI consumers using `@parity/product-sdk-terminal`** — host-papp `0.8.7-1` renamed the on-disk session storage key (`SsoSessionsV2` → `SsoSessionsV3`) and added a required `deviceEncPubKey: Bytes(65)` field on the persisted session. Sessions persisted from a previous CLI run will be invisible after upgrading; users will need to re-pair their phone the first time they launch the upgraded CLI. The `UserSecretsV2_<sessionId>.json` file format is unchanged.

  ### What's new

  **Upstream catalog bump.** `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, `@novasamatech/storage-adapter`, and `@novasamatech/substrate-slot-sr25519-wasm` move from `^0.8.6` to `^0.8.7-2`. Headlines from upstream (between `release: 0.8.6 (#208)` and `chore(release): publish 0.8.7-2`):

  - **`deviceEncPubKey` on the V2 session schema** (upstream PR #212). The persisted session codec gains a required `deviceEncPubKey: Bytes(65)` — the paired phone's long-lived ECDH key, lifted from `HandshakeResponseV2.deviceEncPubKey`, used by the host's device-sync channel. The storage key was renamed `SsoSessionsV2 → SsoSessionsV3` in the same release; the old graceful-degrade for V2 blobs is gone.
  - **Statement-store allowance-slot-prover fix** (upstream PR #214). `AllowanceService.getStatementStoreProver` now uses `createSlotAccountProver` instead of `createSr25519Prover` — fixes a signature-scheme mismatch when proving slot-account-derived secrets. No public API change on our side (our `getStatementStoreProver` wrapper passes through unchanged), but the proofs the returned prover emits are now of the correct scheme.
  - **`ExpiryTooLow` retry handling in `submitWithRetry`** (upstream `73cb870`). Internal to host-papp/statement-store retry logic; no consumer-side change.

  ### `@parity/product-sdk-terminal`

  Internal codec mirror used by `createTestSession` updated to match host-papp 0.8.7-2's reshaped session schema:

  - Appended `deviceEncPubKey: Bytes(65)` to the mirrored codec; the synthesized field reuses the remote peer's P-256 encryption pubkey (same value already used for `identityChatPublicKey` and `ssoEncPubKey`).
  - Storage-key rename: `SsoSessionsV2.json` → `SsoSessionsV3.json`. The in-source unit tests and TSDoc references all updated.

  No public-API change; `createTestSession`'s signature is unchanged. The interop test continues to round-trip the synthesized session through the real `SsoSessionManager` and `UserSecretRepository` to catch upstream drift early — both interop suites pass against host-papp 0.8.7-2.

  ### `@parity/product-sdk-host`, `@parity/product-sdk-signer`, `@parity/product-sdk-statement-store`

  Patch-bumped to signal "tested against host-api(-wrapper) 0.8.7-2" via the published peer-dep / catalog resolution. No source change; runtime behavior is unchanged.

  ### Migration

  **`@parity/product-sdk-terminal` — existing sessions need to be re-paired.** No source change required, but any sessions persisted to disk by a previous CLI run will be invisible after upgrading. host-papp 0.8.7-2 reads from `<storageDir>/<appId>_SsoSessionsV3.json`; the previous `SsoSessionsV2.json` path is no longer consulted, and the old graceful-degrade for stale blobs is gone.

  What this means in practice:

  - A user upgrading the CLI will see the same UX they'd see on a fresh install — `waitForSessions` returns no sessions until they complete a QR pairing.
  - The old `SsoSessionsV2.json` file is not deleted, just ignored. Optional cleanup: surface a one-liner to the user ("we updated the session format, please re-pair") and `fs.unlink` the legacy path.
  - The `UserSecretsV2_<sessionId>.json` file format is unchanged; legacy secrets files become orphaned (the new session has a different `sessionId`) but don't cause errors.
  - Synthesized test sessions emitted by `createTestSession` automatically write to the new path — no test code change needed unless your tests asserted on the old filenames.

- Updated dependencies [2124e02]
- Updated dependencies [2124e02]
  - @parity/product-sdk-host@0.9.0

## 0.4.4

### Patch Changes

- Updated dependencies [a2fd276]
  - @parity/product-sdk-host@0.8.0

## 0.4.3

### Patch Changes

- d4bc935: Bump `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, and `@novasamatech/storage-adapter` from `^0.8.5` to `^0.8.6`.

  0.8.6 lands RFC-0007 (PR #205 upstream — derive product entropy from `rootEntropySource`) and a `polkadot-api` bump to `2.1.6` (double-notification fix). The RFC-0007 work changes the on-disk session and secrets schemas:

  - **Session** (`SsoSessions` → `SsoSessionsV2`): dropped the `Option` wrapper on `identityAccountId`, `identityChatPublicKey`, and `ssoEncPubKey` (all now required); appended `rootEntropySource: Bytes(32)` for the host's `host_derive_entropy` handler.
  - **Secrets** (`UserSecrets` → `UserSecretsV2`): dropped `entropy` (now lives on the session as `rootEntropySource`); added the V2 `identityChatPrivateKey: Bytes(32)`.
  - **Graceful-degrade removed.** Old-shape blobs no longer fall back to empty — they now throw at decode. A CLI on 0.8.5 disk state will need to re-pair after the consumer upgrades.

  `host-api` and `host-api-wrapper` had no source changes in 0.8.6 (lockstep version tag only) — `host`, `signer`, and `statement-store` are patch-bumped to signal "tested against 0.8.6" via published peer-dep / catalog resolution; their runtime behavior is unchanged.

  In `@parity/product-sdk-terminal`, the internal codec mirror for `createTestSession` was updated to match the 0.8.6 session and secrets shapes — including the storage-key rename to `*V2` — so synthesized test sessions round-trip cleanly through the real 0.8.6 `SsoSessionManager` / `UserSecretRepository`. No public-API change in any of the four packages.

- Updated dependencies [d4bc935]
  - @parity/product-sdk-host@0.7.1

## 0.4.2

### Patch Changes

- Updated dependencies [f6bdaaf]
  - @parity/product-sdk-host@0.7.0

## 0.4.1

### Patch Changes

- dc3a452: Bump `@novasamatech/host-api` and `@novasamatech/host-api-wrapper` to `^0.8.4`.

  0.8.4 ships the `getLegacyAccountSigner` SS58 fix: the wrapper now sends an
  SS58 address as the wire `signer` instead of a raw hex public key, so
  legacy-account `signRaw`/`signPayload` are accepted by the wallet instead of
  rejected. Fixes the root cause behind
  [paritytech/product-sdk#156](https://github.com/paritytech/product-sdk/issues/156).

- dc3a452: Bump shared catalog dependencies to their latest within range. Dependency-range updates only; no public API changes:

  - `polkadot-api` `^2.1.2` → `^2.1.5` (all packages listed)
  - `@polkadot-labs/hdkd-helpers` `^0.0.27` → `^0.0.30` (contracts, keys, tx)
  - `viem` `^2.46.2` → `^2.52.0` (contracts)
  - `@novasamatech/host-api` & `@novasamatech/host-api-wrapper` `^0.8.0` → `^0.8.3` (signer's optional deps; host/statement-store carry them as dev-only/unchanged peers)

- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
  - @parity/product-sdk-host@0.6.1

## 0.4.0

### Minor Changes

- 551c1bb: **Migrate to `@novasamatech/host-api(-wrapper)` v0.8.**

  Hosts now deliver `host-api` 0.8, and products must run a matching
  `@novasamatech/host-api-wrapper` — v0.8 is wire-incompatible with v0.7.
  The catalog now pins both at `^0.8.0`, and the `host` / `statement-store`
  peer ranges require `>=0.8.0`. The Polkadot Module / SSO integration
  (`@novasamatech/host-papp` and friends, used by
  `@parity/product-sdk-terminal`) intentionally stays on 0.7.x for now, so
  `terminal` is unchanged.

  Breaking changes surfaced to consumers of these packages:

  - **`@parity/product-sdk-host` — theme payload is now a struct.** The
    `subscribeTheme` callback (`getThemeProvider`) delivers a `ThemeMode`
    `{ name, variant }` object instead of a flat `"Light" | "Dark"` string.
    Read `theme.variant` for the light/dark value and `theme.name` for the
    theme name (`{ tag: "Default" }` or `{ tag: "Custom", value }`). New
    `ThemeVariant` and `ThemeName` types are exported.
  - **`@parity/product-sdk-host` — resource-allocation tag renamed.** The
    `AllocatableResource` / `AllocatableResourceTag` value `BulletInAllowance`
    is now `BulletinAllowance`; the `RemotePermission` tag `WebRTC` is now
    `WebRtc` (pure renames from the upstream codec).
  - **`@parity/product-sdk-signer` / `@parity/product-sdk-statement-store`**
    now require the v0.8 wrapper to stay wire-compatible with a v0.8 host.

### Patch Changes

- Updated dependencies [551c1bb]
  - @parity/product-sdk-host@0.6.0

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
