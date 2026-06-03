# @parity/product-sdk-terminal

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
