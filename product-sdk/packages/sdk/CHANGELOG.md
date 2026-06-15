# @parity/product-sdk

## 0.13.0

### Minor Changes

- acb2228: **Make `@novasamatech/*` runtime dependencies instead of optional peer dependencies.**

  `@parity/product-sdk-host` now declares `@novasamatech/host-api` and
  `@novasamatech/host-api-wrapper` as regular `dependencies` (via the existing `catalog:`
  range) rather than optional `peerDependencies`. `host-api` was always required at runtime
  — its `enumValue` is statically imported by the published bundle — so the optional-peer
  declaration was incorrect; `host-api-wrapper` is loaded lazily by the host bridge and is
  now pulled transitively too. Consumers can reach the host APIs purely through
  `@parity/product-sdk-host` with no direct `@novasamatech/*` dependency of their own.

- acb2228: **Add `productAccount.requestName` opt-out and a public `HostProvider.getUserId()`.**

  When `HostProviderOptions.productAccount` is set, `connect()` populates
  `SignerAccount.name` from the host primary username via `getUserId()`.
  That host call triggers an identity-permission prompt, which is wasted
  for apps that don't display the name.

  Two additions, both backward-compatible (default behavior unchanged):

  - **`productAccount.requestName`** (default `true`). Set it to `false` to
    skip the `getUserId()` fetch entirely — no name, no prompt — for apps
    with their own display chain (e.g. registry username → fallback).
  - **`HostProvider.getUserId(): Promise<Result<{ primaryUsername }, SignerError>>`**.
    Fetch the name lazily on demand — e.g. on a profile screen — for apps
    that opted out at connect, or that want to react to a `PermissionDenied`
    / `NotConnected` rejection explicitly rather than silently getting a
    nameless account. Mirrors the existing `getProductAccount` /
    `getProductAccountAlias` public methods.

  Existing `productAccount` consumers see no change.

  ```ts
  // Default: name fetched at connect (host identity prompt), as before.
  new HostProvider({ productAccount: { dotNsIdentifier: "myapp.dot" } });

  // Opt out of the connect-time prompt; fetch the name later if needed.
  const provider = new HostProvider({
    productAccount: { dotNsIdentifier: "myapp.dot", requestName: false },
  });
  // ...later, when a screen actually needs the name:
  const result = await provider.getUserId();
  if (result.ok) console.log(result.value.primaryUsername);
  ```

### Patch Changes

- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
  - @parity/product-sdk-host@0.10.0
  - @parity/product-sdk-signer@0.7.0
  - @parity/product-sdk-chain-client@0.7.2
  - @parity/product-sdk-cloud-storage@0.6.2
  - @parity/product-sdk-local-storage@0.2.7
  - @parity/product-sdk-contracts@0.7.5
  - @parity/product-sdk-keys@0.3.8
  - @parity/product-sdk-tx@0.2.12

## 0.12.0

### Minor Changes

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

- 2124e02: **Add a `getNotificationManager()` host wrapper.**

  `getNotificationManager()` returns the host's `notificationManager` singleton
  (`push` / `cancel`), matching the `getPaymentManager` / `getPreimageManager`
  pattern. The module also re-exports `PushNotificationError` (with its
  `ScheduleLimitReached` variant, for `instanceof` branching on the host's
  pending-notification cap) plus the derived `NotificationId` /
  `PushNotificationInput` types.

  Lets consumers reach the host push-notification surface without importing
  `@novasamatech/host-api(-wrapper)` directly.

### Patch Changes

- Updated dependencies [2124e02]
- Updated dependencies [2124e02]
- Updated dependencies [2124e02]
  - @parity/product-sdk-host@0.9.0
  - @parity/product-sdk-signer@0.6.4
  - @parity/product-sdk-cloud-storage@0.6.1
  - @parity/product-sdk-chain-client@0.7.1
  - @parity/product-sdk-local-storage@0.2.6
  - @parity/product-sdk-contracts@0.7.4
  - @parity/product-sdk-keys@0.3.7
  - @parity/product-sdk-tx@0.2.11

## 0.11.0

### Minor Changes

- a2fd276: **Add the Summit Network (Web3 Summit) as a new environment.**

  Adds `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
  (the People chain) descriptors, and wires `summit` through the host
  Bulletin RPC list, the cloud-storage network preset, and
  `getChainAPI("summit")`. Purely additive — no existing environment,
  descriptor, or endpoint changes.

### Patch Changes

- Updated dependencies [a2fd276]
  - @parity/product-sdk-host@0.8.0
  - @parity/product-sdk-cloud-storage@0.6.0
  - @parity/product-sdk-chain-client@0.7.0
  - @parity/product-sdk-local-storage@0.2.5
  - @parity/product-sdk-signer@0.6.3
  - @parity/product-sdk-keys@0.3.6
  - @parity/product-sdk-contracts@0.7.3
  - @parity/product-sdk-tx@0.2.10

## 0.10.1

### Patch Changes

- Updated dependencies [d4bc935]
  - @parity/product-sdk-host@0.7.1
  - @parity/product-sdk-signer@0.6.2
  - @parity/product-sdk-chain-client@0.6.1
  - @parity/product-sdk-cloud-storage@0.5.5
  - @parity/product-sdk-local-storage@0.2.4
  - @parity/product-sdk-contracts@0.7.2
  - @parity/product-sdk-keys@0.3.5
  - @parity/product-sdk-tx@0.2.9

## 0.10.0

### Minor Changes

- f6bdaaf: **Remove the unused `rpcs` field from `ChainClientConfig`.**

  `createChainClient` routed every connection through the host provider, so
  the `rpcs` endpoints were never read at runtime — the field only forced
  callers to construct and pass a no-op argument. It has been removed, and
  `createChainClient({ chains })` is now the full config shape. The internal
  preset RPC table and the dead `getChainAPI` wiring that fed it were dropped
  as well.

  **Breaking:** callers that passed `rpcs: {...}` will hit a TypeScript
  excess-property error and must delete that key. There is no runtime behavior
  change — the field carried no effect.

  ```diff
   const client = await createChainClient({
       chains: { assetHub: paseo_asset_hub },
  -    rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
   });
  ```

- f6bdaaf: **Surface a catchable error when the host doesn't support a chain, instead of hanging forever.**

  Previously, connecting to a chain the host doesn't recognize (e.g. not enabled
  in the current Desktop/Browser build, or a descriptor genesis hash that drifted
  after a network reset) produced a provider whose JSON-RPC requests were silently
  dropped. Every query against that chain then awaited indefinitely — no rejection,
  no error, no built-in timeout.

  `getHostProvider` now verifies host support (via the same `host_feature_supported`
  check the wrapper performs internally) _before_ handing a provider to PAPI, and
  throws the new `ChainNotSupportedError` (carrying the offending `genesisHash`) when
  the host can't serve the chain.

  `createChainClient` degrades per-chain rather than all-or-nothing: supported chains
  in the same call stay fully usable, and an unsupported chain's API throws
  `ChainNotSupportedError` on first use (e.g. `client.assetHub.query…`) instead of
  hanging. This matches the reported behaviour where one chain (Bulletin) keeps
  working while another is unavailable. A hard failure (e.g. not running inside a
  container) still rejects the whole call as before.

  ```ts
  import {
    createChainClient,
    ChainNotSupportedError,
  } from "@parity/product-sdk-chain-client";

  const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub, bulletin: paseo_bulletin },
  });

  try {
    await client.assetHub.query.System.Number.getValue();
  } catch (err) {
    if (err instanceof ChainNotSupportedError) {
      // err.genesisHash — the chain the host refused
    }
  }

  // Other chains in the same client are unaffected:
  await client.bulletin.query.TransactionStorage.ByteFee.getValue();
  ```

  `ChainNotSupportedError` is exported from both `@parity/product-sdk-host` and
  `@parity/product-sdk-chain-client`. Connecting outside a host container still
  returns `null` / throws the existing "host provider unavailable" error.

### Patch Changes

- Updated dependencies [f6bdaaf]
- Updated dependencies [f6bdaaf]
  - @parity/product-sdk-chain-client@0.6.0
  - @parity/product-sdk-host@0.7.0
  - @parity/product-sdk-cloud-storage@0.5.4
  - @parity/product-sdk-local-storage@0.2.3
  - @parity/product-sdk-signer@0.6.1
  - @parity/product-sdk-keys@0.3.4
  - @parity/product-sdk-contracts@0.7.1
  - @parity/product-sdk-tx@0.2.8

## 0.9.0

### Minor Changes

- dc3a452: **Add `HostProviderOptions.productAccount` for product-account-only apps.**

  Apps that sign exclusively with a per-dapp derived product account (no
  wallet picker — typical for the modern PoP-mediated flow) can now pass
  `productAccount: { dotNsIdentifier, derivationIndex? }` when constructing
  `HostProvider`. When set, `connect()`:

  - Skips `getLegacyAccounts()` entirely.
  - Fetches the product account via `getProductAccount(dotNsIdentifier, derivationIndex)`.
  - Best-effort fetches the user's primary username via `getUserId()`
    and uses it as `SignerAccount.name` so apps can render
    `Hello, {name}` instead of a truncated address. Failures
    (`NotConnected`, `PermissionDenied`, codec drift) leave `name` null —
    connect still succeeds, callers fall back to whatever display rule
    they already use.
  - Returns it as a single-element `SignerAccount[]` so it flows into
    `SignerState.accounts` and becomes `selectedAccount` like any other
    account.
  - Wires `getSigner` through `getProductAccountSigner` (pinned to
    `createTransaction`).

  This obsoletes the ~25-line `class extends HostProvider` workaround every
  product app was carrying. Critically, it also fixes a v0.5.0 regression:
  when the host returns no legacy accounts, `super.connect()` rejects with
  `NoAccountsError` _before_ any product-account fetch can happen — leaving
  product-only apps stuck in `status: "disconnected"`. The new option
  bypasses that branch entirely.

  Existing consumers (apps that don't set `productAccount`) see no
  behavior change.

  Example:

  ```ts
  new HostProvider({
    productAccount: { dotNsIdentifier: "myapp.dot" },
  });
  ```

### Patch Changes

- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
  - @parity/product-sdk-host@0.6.1
  - @parity/product-sdk-signer@0.6.0
  - @parity/product-sdk-chain-client@0.5.3
  - @parity/product-sdk-cloud-storage@0.5.3
  - @parity/product-sdk-contracts@0.7.0
  - @parity/product-sdk-keys@0.3.3
  - @parity/product-sdk-tx@0.2.7
  - @parity/product-sdk-local-storage@0.2.2

## 0.8.0

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
  - @parity/product-sdk-signer@0.5.0
  - @parity/product-sdk-chain-client@0.5.2
  - @parity/product-sdk-cloud-storage@0.5.2
  - @parity/product-sdk-local-storage@0.2.1
  - @parity/product-sdk-contracts@0.6.2
  - @parity/product-sdk-keys@0.3.2
  - @parity/product-sdk-tx@0.2.6

## 0.7.2

### Patch Changes

- Updated dependencies [2498950]
  - @parity/product-sdk-contracts@0.6.1

## 0.7.1

### Patch Changes

- @parity/product-sdk-chain-client@0.5.1
- @parity/product-sdk-cloud-storage@0.5.1

## 0.7.0

### Minor Changes

- 7610e61: ### `@parity/product-sdk-host`

  - New wrappers: `getChatManager`, `getThemeProvider`, `deriveEntropy`, `requestPermission`, `requestDevicePermission`.
  - New container helpers: `createHostLocalStorage`.
  - New TruAPI re-exports: `createHostPreimageManager`, `formatHostError`.
  - New type re-exports: `ProductAccountId`, `SignedStatement`, `Statement`, `Topic`, `ChatManager`, `ChatMessageContent`, `ChatReceivedAction`, `ChatRoom`, `ChatRoomRegistrationResult`, `ChatBotRegistrationResult`, `ChatCustomMessageRenderer`, `ChatCustomMessageRendererParams`, `ThemeMode`, `ThemeProvider`, `DevicePermissionKind`, `RemotePermissionItem`.

  ### `@parity/product-sdk-chain-client`

  - New exports: `WellKnownChain` constant + `WellKnownChainHash` type for canonical genesis-hash lookups.

  ### `@parity/product-sdk-local-storage`

  - Widened the typed KV interface to match the upstream Novasama surface: `readBytes` / `writeBytes` methods and keyed `clear(key)`. Test mocks updated accordingly.

  ### Umbrella

  - `@parity/product-sdk`: minor cascade per `RELEASES.md` — any constituent minor bump cascades the umbrella.

  No consumer-facing source-compat breaks: all changes are additive expansions of public exports.

- 7610e61: **Drop previewnet support.**

  Previewnet is no longer used. Removed across the workspace:

  - `@parity/product-sdk-descriptors` drops the `./previewnet-asset-hub`, `./previewnet-bulletin`, and `./previewnet-individuality` subpath exports.
  - `@parity/product-sdk-chain-client` removes `"previewnet"` from the `Environment` union; `getChainAPI("previewnet")` no longer compiles or resolves.
  - `@parity/product-sdk-cloud-storage` removes the `previewnet` entry from `CloudStorageNetworks`.
  - `@parity/product-sdk-host` removes `BULLETIN_RPCS.previewnet`.

  ### Migration

  Consumers using paseo (testnet) or one of the production environments are unaffected. Anyone importing a `previewnet-*` descriptor or referencing `Environment === "previewnet"` should drop the references — the underlying runtime is shared with paseo, so paseo is the direct replacement for testing.

  Pre-1.0 breaking change per `RELEASES.md`; ships as `minor`.

- 7610e61: **Add `getPaymentManager` for RFC-0006 host payments.**

  `@parity/product-sdk-host` now exports `getPaymentManager()` plus the `PaymentManager`, `PaymentBalance`, `PaymentStatus`, and `TopUpSource` types. The wrapper returns the shared `paymentManager` singleton from `@novasamatech/host-api-wrapper`, matching the singleton pattern already used by `getPreimageManager`, `getHostLocalStorage`, and `getAccountsProvider`.

  Closes the last `@novasamatech/host-api-wrapper` direct-import in the host-playground migration: callers can swap `createPaymentManager()` for `await getPaymentManager()`.

  Distinct from the CoinPayment / merchant-payments surface (RFC-0017). This is the user-initiated balance / top-up / payment-request flow.

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

- 7610e61: Rename `@parity/product-sdk-bulletin` to `@parity/product-sdk-cloud-storage` and abstract the public surface away from chain-specific naming. The package is still backed by the Polkadot Bulletin Chain — the rename only affects user-facing types, methods, and configuration so callsites no longer need to know about the underlying implementation.

  ### Migration

  | Before                                 | After                               |
  | -------------------------------------- | ----------------------------------- |
  | `@parity/product-sdk-bulletin`         | `@parity/product-sdk-cloud-storage` |
  | `BulletinClient`                       | `CloudStorageClient`                |
  | `BulletinApi`                          | `CloudStorageApi`                   |
  | `BulletinChain` (preset record)        | `CloudStorageNetworks`              |
  | `BulletinNetwork` (interface)          | `CloudStorageNetwork`               |
  | `BulletinEnvironment`                  | `CloudStorageEnvironment`           |
  | `CreateBulletinClientOptions`          | `CreateCloudStorageClientOptions`   |
  | `ProductBulletinError`                 | `ProductCloudStorageError`          |
  | `Bulletin*Error` family (our errors)   | `CloudStorage*Error`                |
  | `app.bulletin`                         | `app.cloudStorage`                  |
  | `bulletin?:` config                    | `cloudStorage?:`                    |
  | `@parity/product-sdk/bulletin` subpath | `@parity/product-sdk/cloud-storage` |

  Upstream re-exports from `@parity/bulletin-sdk` (`AsyncBulletinClient`, `BulletinPreparer`, `MockBulletinClient`, `BulletinClientInterface`, `BulletinTypedApi`, `BulletinError`, `ErrorCode`) remain available on the public surface for power users.

  Chain-level identifiers (`chains.bulletin`, `@parity/product-sdk-descriptors/bulletin`, the `paseo` environment) keep their existing names — those packages are explicitly about the chain, not the storage abstraction.

### Patch Changes

- 7610e61: **Bump `@novasamatech/host-api-wrapper` and `@novasamatech/host-api` to `^0.7.9` (stable).**

  `0.7.9` is the first stable release on the `0.7.9` line. The previous catalog pinned the `0.7.9-6` prerelease exactly (no caret); this bump relaxes both entries to `^0.7.9` so the auto-bumper (`product-sdk-deps-check.yml`) can pick up future patch releases automatically.

  No source-level changes for consumers — `0.7.9` is the same API surface as the prereleases we were already shipping against.

- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
  - @parity/product-sdk-host@0.5.0
  - @parity/product-sdk-chain-client@0.5.0
  - @parity/product-sdk-local-storage@0.2.0
  - @parity/product-sdk-signer@0.4.0
  - @parity/product-sdk-contracts@0.6.0
  - @parity/product-sdk-cloud-storage@0.5.0
  - @parity/product-sdk-keys@0.3.1
  - @parity/product-sdk-tx@0.2.5

## 0.6.0

### Minor Changes

- 4c13257: **Rename `@parity/product-sdk/identity`'s `deriveProductAccount` to `deriveContextAlias` (and `verifyProductAccount` to `verifyContextAlias`, `ProductAccountInfo` to `ContextAliasInfo`, field `productName` to `context`).**

  The identity-subpath helper is a blake2b256-based deterministic alias
  derivation: `aliasPublicKey = blake2b256(parentPublicKey || context)`.
  Used for scoping a parent account to a context label (an app id, a
  voting round, a channel name, etc.). The old `deriveProductAccount`
  naming collided with the _canonical_ sr25519 product-account derivation
  shared with polkadot-desktop and polkadot-app-android-v2: two distinct
  algorithms that produce different outputs from the same inputs. The
  rename makes the algorithmic difference legible at the call site.

  For the canonical sr25519 product-account derivation, see the new
  `deriveProductAccountPublicKey` in `@parity/product-sdk-keys` (this
  release wave).

  ### Breaking changes

  - `deriveProductAccount(parentAddress, productName, ss58Prefix?)` is
    now `deriveContextAlias(parentAddress, context, ss58Prefix?)`. Same
    algorithm, same output bytes, only the names changed.
  - `verifyProductAccount(productAddress, parentAddress, productName)`
    is now `verifyContextAlias(aliasAddress, parentAddress, context)`.
  - Type `ProductAccountInfo` is now `ContextAliasInfo`. Field
    `productName: string` is now `context: string`. Other fields
    (`address`, `h160Address`, `parentAddress`) unchanged.

  Runtime behavior is unchanged on the success path: addresses derived
  under the old API are bit-identical to those derived under the new API
  for the same `(parentAddress, oldProductName === newContext)` pair.

  ### Migration

  Mechanical find/replace across consumer code:

  ```ts
  // Before:
  import {
    deriveProductAccount,
    verifyProductAccount,
    type ProductAccountInfo,
  } from "@parity/product-sdk/identity";

  const acct: ProductAccountInfo = deriveProductAccount(
    parentAddress,
    "my-app"
  );
  const ok = verifyProductAccount(acct.address, parentAddress, "my-app");
  console.log(acct.productName);

  // After:
  import {
    deriveContextAlias,
    verifyContextAlias,
    type ContextAliasInfo,
  } from "@parity/product-sdk/identity";

  const alias: ContextAliasInfo = deriveContextAlias(parentAddress, "my-app");
  const ok = verifyContextAlias(alias.address, parentAddress, "my-app");
  console.log(alias.context);
  ```

  ### Why minor, not major

  Per `RELEASES.md`, pre-1.0 breaking changes go out as `minor` in this
  repo. `@parity/product-sdk` is on `0.5.0`; this rename ships at `0.6.0`.

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

- 4c13257: **Typed permission ergonomics and an `onConnect` lifecycle hook.**

  Two additive changes that collapse the boilerplate every dapp was writing on top of `hostApi.permission` and the once-per-connect side-effect pattern. No breaking changes; existing call sites keep working.

  ### `@parity/product-sdk-host` — `RemotePermission` types + `requestPermission` wrapper

  - **`RemotePermission`, `RemotePermissionTag`, `AllocatableResourceTag`, and `AllocationOutcomeTag`** type aliases are now exported alongside the existing `AllocatableResource` / `AllocationOutcome` aliases. All derive from the `@novasamatech/host-api` SCALE codecs via `CodecType<typeof X>` so schema drift surfaces as a TypeScript error at this boundary instead of silently passing through `as never` casts.

  - **`requestPermission(permission)`** builds the `v1` envelope, calls `hostApi.permission`, and unwraps the response. Returns `Promise<boolean>` and throws on host-unavailable or wire failure — matches the shape of the existing `requestResourceAllocation` so the two helpers compose consistently.

    ```ts
    const granted = await requestPermission({
      tag: "ChainSubmit",
      value: undefined,
    });
    if (!granted) tellUserToReconnect();
    ```

  ### `@parity/product-sdk-signer` — `onConnect` lifecycle hook

  - **`SignerManagerOptions.onConnect`** is a new callback that fires exactly when the manager transitions to `"connected"` with a selected account — not on every subscribe notification while connected. Fires again after auto-reconnect, so a fresh host session re-runs the callback.

    The `ctx` argument exposes a pre-bound `requestResourceAllocation` helper (re-exported from `@parity/product-sdk-host`) plus an `AbortSignal` that fires if the user disconnects or destroys the manager mid-flight. Errors thrown from `onConnect` are logged but do not affect the connected state — the next reconnect retries.

    ```ts
    new SignerManager({
      onConnect: async (_account, { requestResourceAllocation, signal }) => {
        try {
          const outcomes = await requestResourceAllocation([
            { tag: "AutoSigning", value: undefined },
          ]);
          if (signal.aborted) return;
          if (outcomes.some((o) => o.tag !== "Allocated")) {
            logWarning("partial permissions", outcomes);
          }
        } catch (cause) {
          logWarning("resource allocation failed", cause);
        }
      },
    });
    ```

    Replaces ~50 lines of transition-gated subscription, once-per-session bookkeeping, and HMR cleanup that every product app was writing by hand.

### Patch Changes

- 4c13257: **Bump `@parity/host-api-test-sdk` catalog to `^0.8.2`.**

  Picks up [paritytech/host-api-test-sdk#19](https://github.com/paritytech/host-api-test-sdk/pull/19) (and follow-ups) which refresh `PASEO_ASSET_HUB`, `PREVIEWNET`, and `PREVIEWNET_ASSET_HUB` to their live genesis hashes and v2 RPC endpoints. Without this bump, every e2e fixture spreading `...PASEO_ASSET_HUB` was effectively connecting under a stale genesis (v1 paseo, deprecated 2026-05-20), which broke `chain-client-demo` and downstream signing demos with `Tracking stopped` / `BadProof` / `AsPgas` errors depending on the path.

  ### What changed in the test SDK

  | Constant                           | Old                                     | New                                          |
  | ---------------------------------- | --------------------------------------- | -------------------------------------------- |
  | `PASEO_ASSET_HUB.genesisHash`      | `0xd6eec261...`                         | `0x173cea9d...`                              |
  | `PASEO_ASSET_HUB.rpcUrl`           | `wss://sys.ibp.network/asset-hub-paseo` | `wss://paseo-asset-hub-next-rpc.polkadot.io` |
  | `PREVIEWNET.genesisHash`           | `0xdd51f3c2...`                         | `0x477dd87a...`                              |
  | `PREVIEWNET_ASSET_HUB.genesisHash` | `0x7765f98d...`                         | `0x860d75a8...`                              |

  ### Consumer impact

  - **No source change** in any published `@parity/product-sdk-*` package. `@parity/host-api-test-sdk` is a `devDependency` of our example demos only — consumers installing the SDK from npm don't see this bump at all.
  - **Internal contributors** writing e2e specs against `wss://sys.ibp.network/asset-hub-paseo` or any v1 paseo genesis must update to the v2 equivalents. Per-fixture changes are usually a one-line override since most spread `...PASEO_ASSET_HUB`.

  ### Verification

  `pnpm test:e2e` runs cleanly across all demos against paseo v2 with the new SDK pulled in via the catalog (no overrides). Replaces the prior local-tarball override workflow that was a stopgap while waiting for `@parity/host-api-test-sdk@0.8.x` to publish.

- Updated dependencies [4c13257]
- Updated dependencies [4c13257]
  - @parity/product-sdk-keys@0.3.0
  - @parity/product-sdk-host@0.4.0
  - @parity/product-sdk-signer@0.3.0
  - @parity/product-sdk-bulletin@0.4.2
  - @parity/product-sdk-chain-client@0.4.2
  - @parity/product-sdk-contracts@0.5.1
  - @parity/product-sdk-tx@0.2.4
  - @parity/product-sdk-storage@0.1.5

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

- Updated dependencies [bdeb144]
- Updated dependencies [bdeb144]
  - @parity/product-sdk-contracts@0.5.0
  - @parity/product-sdk-host@0.3.0
  - @parity/product-sdk-bulletin@0.4.1
  - @parity/product-sdk-chain-client@0.4.1
  - @parity/product-sdk-signer@0.2.4
  - @parity/product-sdk-storage@0.1.4
  - @parity/product-sdk-keys@0.2.3
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
- Updated dependencies [1cc3790]
  - @parity/product-sdk-contracts@0.4.0
  - @parity/product-sdk-chain-client@0.4.0
  - @parity/product-sdk-bulletin@0.4.0
  - @parity/product-sdk-host@0.2.2
  - @parity/product-sdk-signer@0.2.3
  - @parity/product-sdk-storage@0.1.3
  - @parity/product-sdk-keys@0.2.2
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
  - @parity/product-sdk-signer@0.2.2
  - @parity/product-sdk-chain-client@0.3.0
  - @parity/product-sdk-bulletin@0.3.0
  - @parity/product-sdk-storage@0.1.2
  - @parity/product-sdk-contracts@0.2.2
  - @parity/product-sdk-keys@0.2.1
  - @parity/product-sdk-tx@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies [6fc8188]
- Updated dependencies [6fc8188]
- Updated dependencies [6fc8188]
  - @parity/product-sdk-bulletin@0.2.1
  - @parity/product-sdk-contracts@0.2.1
  - @parity/product-sdk-signer@0.2.1
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
  - @parity/product-sdk-local-storage@0.1.0
  - @parity/product-sdk-tx@0.1.0
