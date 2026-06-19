# @parity/product-sdk-signer

## 0.8.3

### Patch Changes

- Updated dependencies [ef14a41]
  - @parity/product-sdk-host@0.11.0
  - @parity/product-sdk-keys@0.3.12

## 0.8.2

### Patch Changes

- 8dd1232: chore(deps): bump polkadot-api to 2.1.6

  Updates the `polkadot-api` catalog entry `^2.1.5` → `^2.1.6` (2.1.6 carries the
  double-notification fix). Every published package resolves `polkadot-api`
  through `catalog:`, so each one's published `dependencies` range moves to
  `^2.1.6`. There is no source change in any package — these are patch bumps to
  ship the new floor via the published `catalog:` resolution.

  Releases the catalog bump from #223, which was merged to `main` without a
  changeset.

- Updated dependencies [8dd1232]
  - @parity/product-sdk-host@0.10.3
  - @parity/product-sdk-keys@0.3.11

## 0.8.1

### Patch Changes

- c39332e: chore(deps): bump @novasamatech/\* host SDKs to 0.8.9

  Update the upstream host-API SDKs to the 0.8.9 release:

  - catalog: `@novasamatech/host-api` and `@novasamatech/host-api-wrapper` `^0.8.8` → `^0.8.9`
  - terminal: `@novasamatech/host-papp`, `@novasamatech/statement-store`, `@novasamatech/storage-adapter`, and `@novasamatech/substrate-slot-sr25519-wasm` `^0.8.8` → `^0.8.9`

  `@novasamatech/sdk-statement` is unaffected (separate package, latest is 0.6.0).

- c39332e: **`SignerManager.connect("host")` now derives a product account from `dappName` instead of calling the host's legacy-account enumeration.**

  On Proof-of-Personhood / product-account hosts (Polkadot Desktop today, Polkadot Mobile going forward), `accounts.getLegacyAccounts()` is hard-coded to return `[]` by design — the host exposes only per-dapp product accounts via enumeration and never the user's identity account. Pre-this-PR, calling `app.wallet.connect()` on such hosts surfaced `NoAccountsError`, which made the simplest possible "connect a wallet" flow unusable.

  ### What changed

  `HostProvider.tryConnect()`:

  - The legacy-fetch branch (`provider.getLegacyAccounts()` → `mapAccounts(...)` → `NoAccountsError` on empty) is replaced with a derivation branch (`fetchProductSignerAccount(dappName + ".dot", 0)`).
  - When `dappName` is not set, OR the host rejects the derivation (typically because the dotNS identifier isn't registered for this user), `connect()` resolves with `ok([])` rather than throwing. Consumers can still drive the explicit signing paths (`wallet.signMessageWithDotNsIdentity`, `accounts.getLegacyAccountSigner`).
  - `HostProviderOptions` gains a `dappName?: string` field, wired through automatically from `SignerManager` (consumers don't pass it directly).
  - The `AccountsProvider` interface drops the now-unused `getLegacyAccounts` field. `getLegacyAccountSigner` is **kept** — it's the load-bearing primitive for explicit-name signing (used by `wallet.signMessageWithDotNsIdentity`).

  ### No public API change

  - `SignerManager` constructor, `connect()`, and all other methods: unchanged.
  - `HostProvider` constructor: unchanged (`dappName` is additive).
  - `app.wallet.connect()` return shape: unchanged (`{ accounts: Account[] }`).
  - `getLegacyAccountSigner`, `getProductAccount`, `getProductAccountAlias`, `getUserId`, `createRingVRFProof`, `subscribeAccountConnectionStatus`: unchanged.

  ### Behavioral note for consumers

  Anyone catching `NoAccountsError` to gate UI on Polkadot Desktop will see the error go away — `connect()` now resolves with one product-derived account (when the host can derive it) or an empty list (when it can't). Most consumers handle empty arrays gracefully; if you guarded on `NoAccountsError` specifically, switch to checking `accounts.length === 0`.

  The `dappName` you pass to `createApp({ name })` or `new SignerManager({ dappName })` is now also the dotNS identifier the host derives the product account from. `.dot` is appended automatically if missing. If your `dappName` isn't a valid registered dotNS identifier, the host will reject the derivation and `connect()` will resolve with `[]` — usable for explicit-name signing flows but no enumerated account.

- Updated dependencies [c39332e]
  - @parity/product-sdk-host@0.10.2
  - @parity/product-sdk-keys@0.3.10

## 0.8.0

### Minor Changes

- 9ce5ab2: **Sign messages with the account that owns a People / People Lite DotNS username, plus a catalog bump to `@novasamatech/host-api` 0.8.8.**

  ### `@parity/product-sdk` — `wallet.signMessageWithDotNsIdentity`

  - `wallet.signMessageWithDotNsIdentity({ peopleChain, username?, message })` — resolves `Resources.UsernameOwnerOf` on the supplied People / Individuality chain descriptor, then signs the message with that account through the host's legacy-account signing path. Returns `{ username, accountId, signature }`.
  - A matching `useWallet` action surfaces the same call from React.
  - Falls back to the host's primary DotNS username when none is supplied (via the host's `accounts.getUserId()` — triggers a host identity-permission prompt).

  **Implementation note (worth knowing for consumers).** The owning account is named explicitly via the host's `getLegacyAccountSigner({ publicKey })` rather than matched against an enumerated wallet list. On Proof-of-Personhood / product-account hosts (e.g. Polkadot Desktop), the connected-accounts list returned by `getLegacyAccounts()` is intentionally empty — the host exposes only per-dapp product accounts via enumeration and never surfaces the user's identity account. Such hosts still sign with that account when it's _named explicitly_ (typically behind a user-approval prompt), and that's the path this flow uses.

  **Chain-connection lifecycle is automatic.** The SDK reuses an existing chain client when `app.chain.connect({ ..., <name>: peopleChain })` was called upfront (matched by genesis), and falls back to opening a transient connection otherwise. For long-running apps, call `app.chain.connect` once at startup to avoid the cold-path cost.

  ### `@parity/product-sdk-signer` — `SignerManager.getUserId()`

  `SignerManager.getUserId()` wraps the existing `HostProvider.getUserId()` for callers that want to fetch the host primary username without going through a product-account-derivation flow. Returns `HostUnavailableError` when not connected via host, `DestroyedError` after `destroy()`.

  ### Catalog bump — `@novasamatech/host-api` family `^0.8.7` → `^0.8.8`

  `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, `@novasamatech/storage-adapter`, and `@novasamatech/substrate-slot-sr25519-wasm` move from `^0.8.7` to `^0.8.8`. The headline from upstream is the **legacy sign-request protocol** (PR #218): new `signRawLegacy` / `createTransactionLegacy` UserSession methods plus the matching SCALE codecs (`SignRawLegacyRequest`/`Response`, `CreateTransactionLegacyRequest`, `LegacyTransaction`). This is the protocol scaffolding the new `signMessageWithDotNsIdentity` flow relies on for signing with a wallet's identity account.

  No session/secrets codec changes — `terminal`'s `testing.ts` codec mirror round-trips cleanly against 0.8.8; both interop suites pass.

  ### Example

  ```ts
  import { createApp } from "@parity/product-sdk";
  import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";

  const app = await createApp({ name: "my-app" });

  // Recommended: connect the People chain upfront to share one chainHead
  // subscription across every subsequent identity sign.
  await app.chain.connect({ people: paseo_individuality });

  // No prior `app.wallet.connect()` required — the signing flow names the
  // identity account directly and the host prompts the user to approve.
  //
  // Omit `username` to sign with the host's primary username (the one shown
  // for the currently-logged-in user), or pass it explicitly to sign with a
  // specific People-chain identity the user owns.
  const { username, accountId, signature } =
    await app.wallet.signMessageWithDotNsIdentity({
      peopleChain: paseo_individuality,
      message: "verifying ownership",
    });
  ```

### Patch Changes

- Updated dependencies [9ce5ab2]
  - @parity/product-sdk-host@0.10.1
  - @parity/product-sdk-keys@0.3.9

## 0.7.0

### Minor Changes

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

- acb2228: **Bump `@novasamatech/host-api` family from `^0.8.7-2` to `^0.8.7` (stable).**

  Stable `0.8.7` is now published across the family (`host-api`, `host-api-wrapper`, `host-papp`, `statement-store`, `storage-adapter`, `substrate-slot-sr25519-wasm`). This bump removes the prerelease specifier from the published artifact — consumers see a cleaner semver range and get the same upstream code we've been testing against.

  ### Delta vs `0.8.7-2`

  - **`MAX_SSO_REQUEST_SIZE` raised** in `host-papp`: 256 KiB → 500 KiB. Larger Mobile-SSO statements now flow without splitting.
  - **`ExpiryTooLowError` / `AccountFullError` constructors** in `statement-store` accept `bigint` instead of `number`. Internal — our code doesn't construct these directly.
  - **New additive exports** in `statement-store`: `PRIORITY_EPOCH_OFFSET`, `createExpiryAllocator`, `ExpiryAllocator`, `submitWithRetry`, `isPriorityTooLow`, `SubmitRetryOptions`, `signAndSubmitStatement`, `submitStatementOnce`, `SubmitStatementParams`. Not consumed by product-sdk; opt-in for downstream callers.
  - **No session/secrets codec changes.** The `testing.ts` codec mirror in `@parity/product-sdk-terminal` continues to round-trip through the real `SsoSessionManager` and `UserSecretRepository` against 0.8.7 — both interop tests pass.

  No public API change on the product-sdk side; no migration needed.

- acb2228: **`HostProvider.connect()` now returns a specific `HostUnavailableError` instead of a misleading `HostRejectedError` when the app is running outside a Polkadot host container.**

  Reported externally as P0 ("`Failed to connect: Unknown. Environment is not correct`" surfaced by playground-cli's `npm run dev` flow with no way for the user to know what was wrong).

  ### Root cause

  The upstream `@novasamatech/host-api` transport throws `Error("Environment is not correct")` synchronously inside `getLegacyAccounts()` / `getProductAccount()` when `sandboxTransport.isCorrectEnvironment()` returns false (i.e. the app isn't loaded in an iframe under Polkadot Desktop or a WebView under Polkadot Mobile — the dominant case during local `npm run dev`).

  `HostProvider.tryConnect()` was catching that exception at the `getLegacyAccounts()` step and wrapping it as `HostRejectedError("Host rejected account request: Environment is not correct")` — a label that's wrong (no host rejected anything; there's no host at all) and a message that gives the user nothing actionable.

  ### Fix

  Two layered changes, both in `HostProvider.tryConnect()`:

  1. **Pre-check `sandboxTransport.isCorrectEnvironment()` between SDK load and provider creation.** If false, return `HostUnavailableError` with a specific message: _"Host API is not available: not running inside a Polkadot host container. Open this app inside Polkadot Desktop or the Polkadot Mobile WebView, or pick a non-host signer provider (e.g. dev accounts)."_ The check short-circuits before any RPC call, so the user never sees the upstream exception text leak through.

  2. **Safety-net re-classification at the `getLegacyAccounts()` catch.** If the upstream throws `Environment is not correct` deeper than the pre-check (older wrappers without `sandboxTransport`, or race conditions in a WebView teardown), re-classify the error as `HostUnavailableError` rather than wrapping with the misleading `Host rejected account request:` prefix.

  `ProductSdkModule` gains an optional `sandboxTransport?: { isCorrectEnvironment(): boolean }` field so tests and older wrappers without the field continue to work via the safety net.

  `HostUnavailableError`'s TSDoc updated to call out "running outside a host container" as the dominant cause during local development, with `instanceof`-branching guidance for consumers.

  ### Tests

  Three new unit tests in `host.ts` (`signer` package now at 95 tests, was 92):

  - `returns HOST_UNAVAILABLE with actionable guidance when not inside a host container` — exercises the pre-check; asserts `getLegacyAccounts` is never called.
  - `safety net: re-classifies upstream 'Environment is not correct' as HOST_UNAVAILABLE` — exercises the catch-site re-classification for the legacy wrapper path.
  - `connect proceeds when sandboxTransport reports a correct environment` — confirms the pre-check doesn't false-fail on the happy path.

- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
  - @parity/product-sdk-host@0.10.0
  - @parity/product-sdk-keys@0.3.8

## 0.6.4

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
  - @parity/product-sdk-keys@0.3.7

## 0.6.3

### Patch Changes

- Updated dependencies [a2fd276]
  - @parity/product-sdk-host@0.8.0
  - @parity/product-sdk-keys@0.3.6

## 0.6.2

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
  - @parity/product-sdk-keys@0.3.5

## 0.6.1

### Patch Changes

- Updated dependencies [f6bdaaf]
  - @parity/product-sdk-host@0.7.0
  - @parity/product-sdk-keys@0.3.4

## 0.6.0

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
  - @parity/product-sdk-keys@0.3.3

## 0.5.0

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
  - @parity/product-sdk-keys@0.3.2

## 0.4.0

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

- 7610e61: Pin product-account signing to `host_create_transaction` explicitly.

  Both product-account signer entry points — the `getSigner()` returned from `HostProvider.getProductAccount(...)` and the standalone `HostProvider.getProductAccountSigner(...)` method — now pass `signerType: "createTransaction"` to `@novasamatech/host-api-wrapper`'s `accountsProvider.getProductAccountSigner(...)`. The alternate `"signPayload"` path routes via PJS and throws `"PJS does not support this signed-extension: AsPgas"` on chains that ship unknown signed extensions (e.g. Paseo Next's `AsPgas`).

  The `host-api-wrapper@0.7.9` bump that already landed flipped the upstream default to `"createTransaction"`, so AsPgas signing is already unblocked at runtime. This change is **defensive**: it pins our routing explicitly so a future upstream default flip can't silently regress us back through the PJS bridge. Same end-state, plus call-site legibility.

  Legacy-account signing is unchanged — `getLegacyAccountSigner` doesn't expose a `signerType` switch.

  No consumer-facing API change. Hosts must implement `host_create_transaction` (Polkadot Desktop and Mobile do).

- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
  - @parity/product-sdk-host@0.5.0
  - @parity/product-sdk-keys@0.3.1

## 0.3.0

### Minor Changes

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

- Updated dependencies [4c13257]
- Updated dependencies [4c13257]
  - @parity/product-sdk-keys@0.3.0
  - @parity/product-sdk-host@0.4.0

## 0.2.4

### Patch Changes

- Updated dependencies [bdeb144]
  - @parity/product-sdk-host@0.3.0
  - @parity/product-sdk-keys@0.2.3

## 0.2.3

### Patch Changes

- Updated dependencies [1cc3790]
  - @parity/product-sdk-host@0.2.2
  - @parity/product-sdk-keys@0.2.2

## 0.2.2

### Patch Changes

- 5d81610: **Bump `@novasamatech/product-sdk` and `@novasamatech/host-api` to `^0.7.8`.**

  Picks up the latest novasama patch release. Catalog-pinned (`pnpm-workspace.yaml`), so the three consumer packages — `host`, `signer`, and `statement-store` — pick up the new version transitively. No source changes required in this SDK; the upstream patch is backwards-compatible at the API surface novasama exposes to us.

- Updated dependencies [5d81610]
- Updated dependencies [5d81610]
  - @parity/product-sdk-host@0.2.1
  - @parity/product-sdk-keys@0.2.1

## 0.2.1

### Patch Changes

- 6fc8188: **Fix invalid `TransactionSubmit` permission tag sent during `HostProvider.connect()`.**

  After a successful `HostProvider.connect()`, the SDK proactively requests the host's transaction-submit permission so subsequent signing calls don't fail with `PermissionDenied`. The request was being built as `enumValue("v1", { tag: "TransactionSubmit" })`, but `@novasamatech/host-api@0.7.7`'s v1 `RemotePermission` codec defines the legal variants as **Remote | WebRTC | ChainSubmit | PreimageSubmit | StatementSubmit** — no `TransactionSubmit`. The codec's tag-keyed dispatch table returned `undefined` for that tag and the encoder threw client-side before the request reached the host:

  ```
  GenericError: Unknown error: inner[tag] is not a function
  ```

  The throw was caught, but `formatError` collapsed the wrapped result to its outer tag (`"v1"`) and surfaced the unhelpful warning:

  ```
  [signer:host] TransactionSubmit permission rejected by host { error: "v1" }
  ```

  Misleading — it suggested a host-side rejection when in fact it was a schema mismatch between `@parity/product-sdk-signer@0.2.0` and `@novasamatech/host-api@0.7.7` and the host never saw the request.

  `TransactionSubmit` was the variant name in earlier host-api revisions and was renamed to `ChainSubmit` in 0.7. `@parity/product-sdk-signer` was not updated to match.

  ### What changed

  - The permission request now uses `tag: "ChainSubmit"` (with explicit `value: undefined`, which the codec requires for unit-shaped variants).
  - `HostProviderOptions.requestTransactionSubmitPermission` is renamed to `requestChainSubmitPermission`. The old name is kept as a `@deprecated` alias and still controls the same code path — no source-level migration needed for existing callers.
  - `formatError` now walks `{ tag, value }` errors recursively and surfaces the inner Error name + message instead of just the outermost tag. Future schema drift between host-api and the SDK produces legible warnings:
    - Before: `error: "v1"`
    - After: `error: "v1 → GenericError: Unknown error: inner[tag] is not a function"`
  - All log lines mentioning the old `TransactionSubmit` tag now reference `ChainSubmit`.

  Severity: cosmetic in isolation (`connect()` returned ok and signing actually worked because the permission was effectively no-op'd) — but every product app on these versions emitted a misleading warning per connect, and anyone debugging downstream signing failures got pointed at the wrong layer. Fix is a one-tag rename plus better error formatting.

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
  - @parity/product-sdk-address@0.1.1
  - @parity/product-sdk-logger@0.1.1
  - @parity/product-sdk-host@0.2.0
  - @parity/product-sdk-keys@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-address@0.1.0
  - @parity/product-sdk-host@0.1.0
  - @parity/product-sdk-keys@0.1.0
  - @parity/product-sdk-logger@0.1.0
