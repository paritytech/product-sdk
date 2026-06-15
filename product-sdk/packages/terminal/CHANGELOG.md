# @parity/product-sdk-terminal

## 0.5.1

### Patch Changes

- acb2228: **Bump `@novasamatech/host-api` family from `^0.8.7-2` to `^0.8.7` (stable).**

  Stable `0.8.7` is now published across the family (`host-api`, `host-api-wrapper`, `host-papp`, `statement-store`, `storage-adapter`, `substrate-slot-sr25519-wasm`). This bump removes the prerelease specifier from the published artifact — consumers see a cleaner semver range and get the same upstream code we've been testing against.

  ### Delta vs `0.8.7-2`

  - **`MAX_SSO_REQUEST_SIZE` raised** in `host-papp`: 256 KiB → 500 KiB. Larger Mobile-SSO statements now flow without splitting.
  - **`ExpiryTooLowError` / `AccountFullError` constructors** in `statement-store` accept `bigint` instead of `number`. Internal — our code doesn't construct these directly.
  - **New additive exports** in `statement-store`: `PRIORITY_EPOCH_OFFSET`, `createExpiryAllocator`, `ExpiryAllocator`, `submitWithRetry`, `isPriorityTooLow`, `SubmitRetryOptions`, `signAndSubmitStatement`, `submitStatementOnce`, `SubmitStatementParams`. Not consumed by product-sdk; opt-in for downstream callers.
  - **No session/secrets codec changes.** The `testing.ts` codec mirror in `@parity/product-sdk-terminal` continues to round-trip through the real `SsoSessionManager` and `UserSecretRepository` against 0.8.7 — both interop tests pass.

  No public API change on the product-sdk side; no migration needed.

## 0.5.0

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

## 0.4.0

### Minor Changes

- a2fd276: **Expose host-papp's allowance service through `@parity/product-sdk-terminal` with CLI-friendly defaults — including cache-only probes that never trigger a wallet prompt.**

  Four new helpers:

  - `getBulletinSigner(adapter, productId, sessionId?): Promise<PolkadotSigner>` — prompt-allowed fetch (cache hit, or wallet round-trip on miss).
  - `getStatementStoreProver(adapter, productId, sessionId?): Promise<StatementProver>` — same for the statement-store path.
  - `hasBulletinAllowance(adapter, productId, sessionId?): Promise<boolean>` — **cache-only probe**, never prompts the wallet. Resolves `true` when an allowance slot for `(sessionId, productId, bulletin)` is already cached on disk; `false` when it isn't. Use for login health checks, readiness probes, or any path that must not surface a phone dialog.
  - `hasStatementStoreAllowance(adapter, productId, sessionId?): Promise<boolean>` — same for statement-store.

  All four share the same defaulting + error idiom:

  - `sessionId` defaults to the only paired session. When zero or more than one sessions are paired and no id is supplied, all four throw `AllowanceError` with `reason: 'NoSession'`.
  - The fetching helpers (`getBulletinSigner` / `getStatementStoreProver`) unwrap host-papp's neverthrow `ResultAsync` to a `Promise<T>` that throws `AllowanceError` on failure — matching the throwy/async idiom of `createSessionSigner` and `requestResourceAllocation`.
  - The cache-only helpers (`has*Allowance`) read host-papp's encrypted on-disk allowance file directly via a vendored mirror of host-papp's `AllowanceRepository` codec. The mirror will be retired once host-papp exposes a cache-only probe on its public surface; the public surface here won't change.

  `AllowanceError` (and the `AllowanceErrorReason` / `AllowanceService` types) are now re-exported from `@parity/product-sdk-terminal`, so consumers don't need a direct `@novasamatech/host-papp` import.

  ```ts
  import {
    createTerminalAdapter,
    getBulletinSigner,
    hasBulletinAllowance,
    AllowanceError,
  } from "@parity/product-sdk-terminal";

  const adapter = createTerminalAdapter({ appId: "my-cli" });
  // ... QR pair, await waitForSessions(adapter) ...

  if (await hasBulletinAllowance(adapter, "my-cli.dot")) {
    // happy path — no wallet prompt risk
    const signer = await getBulletinSigner(adapter, "my-cli.dot");
    await bulletinClient.tx.TransactionStorage.store({ data }).signAndSubmit(
      signer
    );
  } else {
    console.log("Approve the allowance request on your phone…");
    const signer = await getBulletinSigner(adapter, "my-cli.dot");
    // …
  }
  ```

  The existing `@parity/product-sdk-terminal/host` subpath (`ensureSlotAccountSigner`, `requestResourceAllocation`, `createSlotAccountSigner`, `getCachedAllocation`) is unchanged. Use the `./host` subpath when you need explicit multi-session handling, batched allocation requests, or cache inspection.

## 0.3.2

### Patch Changes

- d4bc935: Bump `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, and `@novasamatech/storage-adapter` from `^0.8.5` to `^0.8.6`.

  0.8.6 lands RFC-0007 (PR #205 upstream — derive product entropy from `rootEntropySource`) and a `polkadot-api` bump to `2.1.6` (double-notification fix). The RFC-0007 work changes the on-disk session and secrets schemas:

  - **Session** (`SsoSessions` → `SsoSessionsV2`): dropped the `Option` wrapper on `identityAccountId`, `identityChatPublicKey`, and `ssoEncPubKey` (all now required); appended `rootEntropySource: Bytes(32)` for the host's `host_derive_entropy` handler.
  - **Secrets** (`UserSecrets` → `UserSecretsV2`): dropped `entropy` (now lives on the session as `rootEntropySource`); added the V2 `identityChatPrivateKey: Bytes(32)`.
  - **Graceful-degrade removed.** Old-shape blobs no longer fall back to empty — they now throw at decode. A CLI on 0.8.5 disk state will need to re-pair after the consumer upgrades.

  `host-api` and `host-api-wrapper` had no source changes in 0.8.6 (lockstep version tag only) — `host`, `signer`, and `statement-store` are patch-bumped to signal "tested against 0.8.6" via published peer-dep / catalog resolution; their runtime behavior is unchanged.

  In `@parity/product-sdk-terminal`, the internal codec mirror for `createTestSession` was updated to match the 0.8.6 session and secrets shapes — including the storage-key rename to `*V2` — so synthesized test sessions round-trip cleanly through the real 0.8.6 `SsoSessionManager` / `UserSecretRepository`. No public-API change in any of the four packages.

## 0.3.1

### Patch Changes

- f6bdaaf: **Fix `createSlotAccountSigner` deriving the wrong public key from a 64-byte slot account key.**

  Mobile hosts return `slotAccountKey` as schnorrkel `SecretKey::to_bytes()` material —
  the canonical scalar (32 bytes) concatenated with the nonce (32 bytes). `buildKeypair`
  fed those 64 bytes straight into `@scure/sr25519`'s `getPublicKey`, which expects the
  `to_ed25519_bytes()` form where the scalar is pre-multiplied by the cofactor (×8).
  The mismatch produced a public key — and therefore an address and signatures — that
  did not match the slot account the host allocated, so submissions signed by the slot
  signer were rejected.

  The 64-byte branch now converts the canonical scalar to the cofactor-multiplied form
  before deriving, so the derived key matches the host's slot account. The 32-byte
  mini-secret path is unchanged.

## 0.3.0

### Minor Changes

- dc3a452: **Route transaction signing through `createTransaction`, derive the product-account key, and remove the obsolete `verifiablejs` WASM loader.**

  Transaction signing (`PolkadotSigner.signTx`) now goes through `session.createTransaction` (the host-papp `CreateTransactionRequest`/`CreateTransactionResponse` SSO pair) instead of `session.signRaw({ tag: "Payload" })`. The paired wallet now builds **and** signs the extrinsic from the structured `ProductAccountTransaction`, so:

  - the wallet can **decode and display** the transaction instead of blind-signing opaque bytes, and
  - every signed extension the chain declares — including ones PAPI's PJS adapter doesn't know (e.g. `AsPgas` on Paseo Next v2) — is forwarded verbatim and survives end-to-end.

  `signBytes` is unchanged (still `session.signRaw({ tag: "Bytes" })` for the anti-phishing envelope).

  **Product-account public key.** `createSessionSigner(session, adapter, publicKey?)` and `ProductAccountRef.publicKey` now accept the host-derived **product-account** sr25519 key. PAPI stamps this into the extrinsic's signer address and verifies against it, so it must be the product account's key (`[productId, derivationIndex]`), not the wallet's selected/root account. When omitted, it falls back to the selected account (correct only when they're the same).

  **Bumps `@novasamatech/host-papp`, `@novasamatech/statement-store`, and `@novasamatech/storage-adapter` `^0.7.7` → `^0.8.1`** (resolves `0.8.3`). 0.8 is wire-incompatible with 0.7 and adds `UserSession.createTransaction`.

  ### Breaking changes

  - **Removed the `@parity/product-sdk-terminal/register` entrypoint** (and its `postinstall` WASM patch). It existed only to redirect `verifiablejs`'s browser-only inline WASM to a Node build; host-papp 0.8 no longer depends on `verifiablejs` (its sr25519 primitives are pure JS), so the loader is obsolete. **Migration:** drop any `--import @parity/product-sdk-terminal/register` flag from your `node`/`tsx` invocations — nothing replaces it.
  - **Dropped the `AttestationStatus` type re-export**, which was removed upstream from `@novasamatech/host-papp` in the same release line.
  - **Removed `TerminalAdapterOptions.metadataUrl`** — host-papp 0.8 no longer embeds app metadata in the pairing proposal, so the field had no effect. **Migration:** drop it from `createTerminalAdapter(...)` calls.

## 0.2.1

### Patch Changes

- bdeb144: **Fix transaction signing for chains with runtime-specific signed extensions (e.g. `AsPgas` on Paseo Next v2).**

  `createSessionSigner` / `createSessionSignerForAccount` previously built their `PolkadotSigner` through `getPolkadotSignerFromPjs`, which translates PAPI's signed-extension map into the fixed Polkadot.js payload shape via a hardcoded mapper table covering eight extensions (`CheckGenesis`, `CheckNonce`, `CheckMortality`, `CheckSpecVersion`, `CheckTxVersion`, `ChargeTransactionPayment`, `ChargeAssetTxPayment`, `CheckMetadataHash`). Anything else threw at signing time:

  ```
  PJS does not support this signed-extension: AsPgas
  ```

  This blocked every transaction on Paseo Next v2's Asset Hub — including the `Revive.map_account()` extrinsic that's prerequisite for product-account contract interactions.

  ### How the fix works

  Swaps the PJS bridge for PAPI's own `getPolkadotSigner`. The new flow:

  - PAPI assembles the SCALE-encoded signing payload from the chain's `metadata.extrinsic.signedExtensions` — every extension survives end-to-end as opaque bytes, including extensions PAPI's PJS adapter doesn't know about.
  - Our signer routes those bytes to `session.signRaw({ data: { tag: "Payload", value: <hex> } })` — the tagged-bytes wire route in `@novasamatech/host-papp` that signs payloads verbatim, with no `<Bytes>...</Bytes>` envelope.
  - The mobile wallet signs the bytes as-is; we return the signature to PAPI, which assembles the final extrinsic.

  Arbitrary-byte signing (`signer.signBytes`) still routes through `session.signRaw` with the `Bytes` tag — keeps the anti-phishing wrap, correct for non-extrinsic user data.

  ### Public API

  Unchanged. `createSessionSigner(session, adapter)` and `createSessionSignerForAccount(session, ref)` keep their signatures and return `PolkadotSigner` as before.

  ### What the fix unblocks

  - `Revive.map_account()` and other Paseo Next v2 Asset Hub extrinsics that include the `AsPgas` signed extension.
  - Any future runtime-specific signed extension — the chain's metadata is the source of truth; PAPI hashes whatever the chain declared, the wallet signs whatever PAPI assembled.
  - `playground-cli dot init` on Paseo Next v2 (was blocked on the asset-hub mapping step).

## 0.2.0

### Minor Changes

- 6fc8188: **Fix unhandled promise rejection from `destroy()` when in-flight statement subscriptions are torn down. `destroy()` is now `async` (`Promise<void>`).**

  `destroy()` previously called `lazyClient.disconnect()` in the same tick as `sessions.dispose()`. `disconnect()` synchronously rejects every still-pending request on the substrate client with `DestroyedError("Client destroyed")` — so the fire-and-forget unsubscribe RPCs that `sessions.dispose()` had just queued never got to leave, and any in-flight statement subscribes rejected. Those rejections surfaced as `Statement subscription error: Client destroyed` console.error logs AND as unhandled promise rejections, which propagate up and crash some test runners.

  ### How the fix works

  The lazy-client is wrapped (`wrapLazyClient`) in a transparent proxy that tracks every server-side unsubscribe fired through `getSubscribeFn`'s teardown callback. `destroy()` then runs:

  1. `sessions.dispose()` — synchronous; calls each wrapped subscribe's teardown, which fires the unsubscribe RPC and records a tracking Promise that resolves two microtask hops later.
  2. `await lazyClient.awaitPendingUnsubs()` — `Promise.allSettled` over the tracked Promises. Resolves once each tracked teardown has had its microtask window.
  3. `lazyClient.disconnect()` — calls `substrateClient.destroy()`. By this point the unsubscribe RPCs have flushed into the WebSocket write queue, so no `DestroyedError` rejections fire on the queued requests.

  No `setTimeout` wall-clock guesswork, no `console.error` monkey-patch, no `process.on('unhandledRejection')` global mutation. The two-microtask wait is a scheduling heuristic — not a true completion observer — but it's empirically reliable on Node because the substrate-client's send path is microtask-scheduled, and it removes the global-state hazards of the previous implementation. Pending subscribes (`onSuccess` not yet fired) are cancelled in-band by the underlying `getSubscribeFn` teardown via `cancelRequest()`, which doesn't surface as a rejection.

  ### API change

  `destroy()` now returns `Promise<void>` instead of `void`. Awaiting is recommended (`await adapter.destroy()`) but not required — callers that ignore the return value get fire-and-forget shape. **Marked as `minor`** because the type signature changed (added a return value), even though the change is structurally additive: TypeScript callers ignoring the return continue to type-check.

### Patch Changes

- 6fc8188: **Fix `BadProof` rejection on every transaction submitted via `createSessionSigner` / `createSessionSignerForAccount`.**

  The signer built `PolkadotSigner` via `getPolkadotSigner` with a single callback that funneled both `signBytes` and `signTx` through `session.signRaw`. The mobile wallet's raw-signing interactor wraps incoming bytes with `<Bytes>...</Bytes>` before signing (anti-phishing) — so when polkadot-api invoked the callback for `signTx` with a SCALE-encoded extrinsic payload, the wallet signed the wrapped form and the chain rejected the resulting signature with `BadProof`.

  Switched to `getPolkadotSignerFromPjs` from `polkadot-api/pjs-signer`, which takes separate `signPayload` and `signRaw` callbacks. Tx signing now routes through `session.signPayload` (mobile's payload interactor — no `<Bytes>` wrap, signs the actual extrinsic) and raw-byte signing keeps using `session.signRaw` (anti-phishing wrap intact).

  No public API changes — `createSessionSigner(session, adapter)` and `createSessionSignerForAccount(session, ref)` keep their signatures. Internal routing is the only thing that changed. The two callbacks are extracted as named internal helpers (`makeSignPayloadCallback`, `makeSignRawCallback`) so the path the bug was on can be exercised directly. Full end-to-end tx signing roundtrip is still gated on the manual smoke test (`packages/terminal/manual-tests/qr-pair-and-sign-tx.mjs`) since CI cannot exercise a real phone.

  Bundle size impact: `dist/index.js` grows from ~10.7 KB to ~19.4 KB. The increase is the metadata-decoder helpers required by the PJS adapter to translate PAPI's signer payload contract into the wire format host-papp expects, plus the now-named callback helpers (kept top-level rather than inlined for testability). `polkadot-api/pjs-signer` itself is externalized.

## 0.1.0

### Minor Changes

- 646d591: **New package: `@parity/product-sdk-terminal` — QR-code login and signing for CLI/Node.js apps.**

  The dev-utility / CLI escape hatch in the `product-sdk` family. Same protocol surface as the in-host SDK packages, but runs in plain Node so a developer can sign with their phone from a terminal — deploy scripts, contract publishers, attestation tools, indexers, scheduled jobs.

  Wraps `@novasamatech/host-papp` with Node-compatible adapters: file-based session storage in `~/.polkadot-apps/`, a `ws-provider` transport, an ESM loader hook that redirects `verifiablejs`'s inline-WASM bundle to its `pkg-nodejs` build.

  ### Public surface

  - `createTerminalAdapter({ appId, metadataUrl, endpoints?, hostMetadata?, storageDir? })` — builds the adapter wired up to file storage + WebSocket. Synchronous; returns a `TerminalAdapter` (extends `PappAdapter`).
  - `createSessionSigner(session, adapter)` — `PolkadotSigner` for the session's default account. Use this for ~all CLI flows.
  - `createSessionSignerForAccount(session, { productId, derivationIndex })` — escape hatch for non-default sub-accounts or a `productId` that differs from the adapter's `appId`.
  - `waitForSessions(adapter, timeoutMs?)` — resolves with persisted sessions (loaded asynchronously from disk) or `[]` after the timeout.
  - `renderQrCode(data, options?)` — Unicode half-block QR code suitable for `console.log`.
  - `createNodeStorageAdapter(appId, storageDir?)` — file-based `StorageAdapter`. Wired in by `createTerminalAdapter`; exposed for advanced setups.
  - Re-exports the `host-papp` types consumers need: `PappAdapter`, `HostMetadata`, `AttestationStatus`, `PairingStatus`, `UserSession`, `StoredUserSession`, `SigningPayloadRequest`, `SigningRawRequest`, `SigningPayloadResponse`.

  ### Setup

  The `host-papp` SDK depends on `verifiablejs` whose default entry inlines WASM (browser-only). Pass the register hook via `--import` to redirect to the Node-compatible build:

  ```bash
  node --import @parity/product-sdk-terminal/register app.js
  tsx --import @parity/product-sdk-terminal/register app.ts
  ```

  ### Testing helpers — `@parity/product-sdk-terminal/testing`

  `createTestSession({ appId, storageDir, ... })` writes a synthesized SCALE-encoded session to disk that round-trips through the real `host-papp` session repositories. Lets E2E tests cover session-discovery, persistence, and logout flows without needing a real phone.

  The mirrored on-disk codec is _not_ part of `host-papp`'s public API — an interop test (`testing.interop.test.ts`) loads a synthesized session through the real repositories on every run, and fails loudly if upstream's format drifts.

  ### Requires

  - Node ≥21 (relies on the global `WebSocket` exposed by `@polkadot-api/ws-provider@0.9`).

  ### Not yet covered

  - The on-chain attestation / allowance refresh flow. A paired session's allowance eventually expires and currently requires re-pairing. Tracked as a follow-up.
  - A QR-pair → phone-signs → statement-store roundtrip in CI. The `--import` smoke test covers loader-hook resolution; everything past that needs a real phone.

### Patch Changes

- Updated dependencies [646d591]
  - @parity/product-sdk-logger@0.1.1
