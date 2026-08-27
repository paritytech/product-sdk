# @parity/product-sdk-host

## 0.17.0

### Minor Changes

- 46e3592: **Export `subscribeConnectionStatus` for host-channel connection state.**

  Watching whether the host channel is up previously meant importing `@parity/truapi/sandbox`
  directly. The callback fires synchronously with the current status and again on every change;
  the returned function unsubscribes. Repeats of the status you already hold are suppressed.

  ```ts
  import {
    subscribeConnectionStatus,
    type HostConnectionStatus,
  } from "@parity/product-sdk-host";

  const unsubscribe = subscribeConnectionStatus((status) => setStatus(status));
  ```

  This is the **transport** channel — for the host's account-level connection, use
  `AccountsProvider.subscribeAccountConnectionStatus`. The type is `HostConnectionStatus` because
  `@parity/product-sdk-signer` already exports `ConnectionStatus` for a signer provider's lifecycle:
  same three states, different meaning.

  Also fixes a stuck status. `@parity/truapi` never clears its cached client when the pipe closes, so
  a subscriber arriving after a disconnect reported `"connecting"` — permanently, and for every other
  subscriber too. This holds `"disconnected"` until a real `"connected"` arrives. Still unfixed as of
  `@parity/truapi` 0.9.0, so the workaround stays until a later release drops it.

  **Testing.** `@parity/product-sdk-host/testing` gains `emitConnectionStatus(status)`, also on
  `FakeHost`, so a product can drive its reconnecting / offline UI. `setTruApiClient` now notifies live
  subscribers when it injects or clears a client.

  **Breaking for implementors.** `emitConnectionStatus` is a required member of the exported `FakeHost`
  interface, so hand-rolled test doubles must add it. Callers of `createFakeHost()` are unaffected.

- 46e3592: **Re-add `previewnet` as a first-class environment.**

  Previewnet was dropped when its identity endpoints weren't secured for public use and its runtime matched paseo. Both have changed: the endpoints are secured, and previewnet now runs a Paseo runtime kept a step ahead of paseo-next-v2 (asset-hub `2000039` vs `2000036`, individuality `1000036` vs `1000032`), so products can build against upcoming runtime changes weeks early.

  - `@parity/product-sdk-descriptors` re-adds the `./previewnet-asset-hub`, `./previewnet-bulletin`, and `./previewnet-individuality` subpath exports, generated fresh against the live endpoints with real (non-zero) `codeHash` values so previewnet is covered by descriptor-drift detection like every other chain.
  - `@parity/product-sdk-chain-client` re-adds `"previewnet"` to the `Environment` union; `getChainAPI("previewnet")` resolves again, routing to the `previewnet.substrate.dev` endpoints for asset-hub, bulletin, and people (individuality).
  - `@parity/product-sdk-cloud-storage` re-adds the `previewnet` entry to `CloudStorageNetworks`.
  - `@parity/product-sdk-host` re-adds `BULLETIN_RPCS.previewnet`.

  Consumers on paseo or a production environment are unaffected; this is purely additive.

### Patch Changes

- 46e3592: **Preserve chain-head operation ordering over TrUAPI.**

  TrUAPI request responses and follow-subscription events travel independently, so a fast body, call, or storage operation can finish before its `Started(operationId)` response reaches the PAPI bridge. The host provider now buffers those early operation events by follow subscription and operation id, emits the JSON-RPC start response first, and then replays the events in arrival order. Buffers are released when the operation, follow subscription, or provider closes. This prevents PAPI from dropping an early completion and waiting indefinitely. No public API changes or consumer migration are required.

- 46e3592: **Use the signed V4 envelope when a runtime also advertises V5.**

  Product-account signers now prefer an advertised Extrinsic V4 format because metadata alone cannot prove that the connected host implements a runtime's V5 authorization pipeline. V5-only runtimes continue to use V5, preserving explicit host capability errors and future authorization support.

- 46e3592: Update `@parity/truapi` to 0.10.0. No SDK API changes: the bump is additive on
  truapi's side and nothing in `@parity/product-sdk-host` consumes the new surface
  yet. 0.10.0 adds `createWebSocketProvider(url)` / `connectWebSocketHost(url)` for
  hosts that serve protocol frames over a WebSocket (so a plain browser tab against
  such a host is detected as hosted and shares the cached client), and exports the
  `PREVIEWNET_INDIVIDUALITY` / `PREVIEWNET_ASSET_HUB` well-known chains. Bumping
  keeps the catalog current with the latest published client.

## 0.16.0

### Minor Changes

- 3655724: **Wrap `account.signVrf` (RFC-0023) in the accounts surface (#288).**

  Producing an sr25519 VRF over a caller-supplied Merlin transcript previously meant
  reaching for the raw `getTruApi()` client. `AccountsProvider` now has
  `signVrf(account, transcriptLabel, items)`, with `HostProvider.signVrf` and
  `SignerManager.signVrf` alongside `createRingVRFProof`. Bytes in, bytes out: the adapter
  owns the hex encoding and the tagged derivation-index selector, and errors use the same
  `Result` channel as every other account call.

  New exported types, also re-exported from `@parity/product-sdk-signer`:
  `VrfTranscriptItem`, `VrfSignature`, and `ProductAccountLookup`
  (`{ dotNsIdentifier, derivationIndex? }`), which a `ProductAccount` satisfies.

  **Breaking for implementors.** `signVrf` is a required member of the exported
  `AccountsProvider` interface, so alternative implementations and hand-rolled test doubles
  must add it. Callers are unaffected, and the fake at `@parity/product-sdk-host/testing`
  already implements it.

  **Host-only.** There is no `DevProvider` implementation and the e2e test host does not
  expose the call, so this returns `HOST_UNAVAILABLE` outside a host container, matching
  `createRingVRFProof`. Use `createFakeHost()` for local tests.

  The caller owns four things the types cannot enforce:

  - _Domain separation_ — a label borrowed from another protocol makes the output
    replayable across both.
  - _Freshness_ — the VRF is deterministic, so per-round values must enter the transcript
    as items; otherwise every call returns the same signature.
  - _Size_ — hosts cap the transcript at 32 items and 8 KiB total and reject anything
    larger as an unknown error. The SDK does not pre-validate.
  - _Authorization_ — an `AutoSigning` allowance makes these calls silent. It is not
    VRF-scoped, so granting it also authorizes other signing with that account.

  Hosts predating the call reject it through the error channel rather than hanging.

- 3655724: Consume TrUAPI host chain discovery. `@parity/product-sdk-host`
  gains `getHostChainInfo()`, a cached facade over `chain.getChainInfo()` that
  resolves chain roles (`AssetHub`, `Bulletin`, `People`, …) to genesis hashes
  and returns `null` on hosts predating discovery. `getChainAPI()` can now be
  called with no argument to derive the environment from the host by matching
  the discovered asset hub genesis against the bundled descriptors; an explicit
  environment is validated the same way, failing with the new `EnvironmentMismatchError` /
  `GenesisMismatchError` instead of an opaque unsupported-genesis error. Only the
  asset hub is fatal there, since it anchors the environment; a bulletin or
  individuality descriptor that disagrees warns and leaves that one chain
  throwing on use, as any chain the host cannot serve already does. Calls
  that pass an environment keep exactly the previous behavior on legacy hosts;
  the zero-arg form needs discovery, so it throws there and outside a container.
  `createFakeTruApiClient` / `createFakeHost` model `chain.getChainInfo` behind a
  new `chainInfo` option, so tests can drive discovery; omitting it models a host
  predating the call. The `chain.getChainInfo` binding this rides on ships in
  `@parity/truapi` 0.9.0, adopted separately.

  The explicit form is only unchanged on legacy hosts. On a host that serves discovery,
  `getChainAPI("paseo")` can now fail where it previously connected:
  `EnvironmentMismatchError` when the host's asset hub genesis matches a different bundled
  environment, and `GenesisMismatchError` when it matches none and the bundled asset hub
  descriptor disagrees with the host. Both surface at the call rather than at the first
  storage read, so an unchanged call site fails earlier and with a different error type.

- 3655724: Add `AccountsProvider.ringVrfSign(keyHandle, message)`, the plain signature under a
  registered ring-VRF member key for protocols that carry their own proof, as opposed to
  `createRingVRFProof`, which proves ring membership. It takes the same opaque
  `RingVrfKeyHandle` as the alias and proof calls, from `listRingVrfKeys` /
  `findRingVrfKeyHandle`, and hands back the signature as bytes. `SignerManager` does not
  wrap it; call the host package's `AccountsProvider` directly.

  **Breaking for implementors.** `ringVrfSign` is a required member of the exported
  `AccountsProvider` interface, so alternative implementations and hand-rolled test doubles
  must add it. Callers are unaffected, and the fake at `@parity/product-sdk-host/testing`
  already implements it.

- 3655724: **Update TrUAPI to 0.9 and require registered ring-VRF key handles.**

  `AccountsProvider`, `HostProvider`, and `SignerManager` now expose
  `registerRingVrfKey(index, ring)` and `listRingVrfKeys(owner, disclosure?)`. Registration returns
  the decoded ring-VRF public key; listing returns `RegisteredRingVrfKey` entries with opaque
  `RingVrfKeyHandle` values. `findRingVrfKeyHandle(keys, ring)` selects a handle by declared
  `RingLocation`, so products do not hard-code another product's derivation index.

  `getProductAccountAlias` and `createRingVRFProof` now require that handle as their first argument.
  This is a compile-time breaking change. It matches TrUAPI 0.9, where the host no longer chooses a
  ring member key implicitly and rejects malformed legacy requests before application dispatch.

  The dependency update also adopts TrUAPI's renamed derivation-index variants: `Index` replaces
  `Left` and `Raw` replaces `Right`. The SDK's ergonomic numeric product-account APIs are unchanged;
  the host adapter performs the `Index` conversion at the wire boundary.

  The signer package's re-exported `RingLocation` now uses TrUAPI's `` chainId: `0x${string}` ``
  instead of a plain `string`; callers loading chain IDs from configuration must narrow or validate
  them before assignment. Custom `HostProviderOptions.loadAccountsProvider` implementations must
  also provide the newly required `registerRingVrfKey` and `listRingVrfKeys` methods.

  `findRingVrfKeyHandle` is exported from `@parity/product-sdk-host`, not from
  `@parity/product-sdk-signer`, which re-exports the ring-VRF types only. A product depending on
  the signer package alone needs `@parity/product-sdk-host` as a second direct dependency for the
  selection step. Prefer the helper over an inline comparison: it requires the junction path to
  match in order and compares chain and collection ids case-insensitively, so a shortcut that
  checks only `chainId` can pick a key registered for a different ring on the same chain.

## 0.15.1

### Patch Changes

- 70c30f3: Update `@parity/truapi` to 0.7.0. No SDK API changes; the client is
  byte-identical to 0.6.0 apart from its embedded `packageVersion` string. It
  pairs with `@parity/truapi-host@0.4.0`, which requires `@parity/truapi`
  `^0.7.0` and holds the actual work: a rebuilt WASM server plus host-side review
  surfaces for RFC-0023 VRF transcript signing (`SignVrfReview`) and RFC-0010
  per-subtree AutoSigning keys (`AutoSigningKey`). Bumping keeps products inside
  the version range that hosts running truapi-host 0.4.0 resolve.

## 0.15.0

### Minor Changes

- bffc04a: Update `@parity/truapi` to 0.6.0. Product-account derivation indexes are now
  tagged `DerivationIndex` selectors on the wire (`{ tag: "Left", value: number }`
  for a plain index, `{ tag: "Right", value: <32-byte hex> }` for a raw index).
  The ergonomic account surfaces keep plain numbers — `getProductAccount(id,
index)` and `ProductAccount.derivationIndex` are unchanged, with the host
  adapter wrapping them as `Left` — but the pass-through shapes track the
  protocol: `ProductProofContext.suffix` (ring VRF contexts, exported from both
  host and signer) is now the tagged selector instead of a hex string, and
  `PaymentTopUpSource`'s `ProductAccount` source and `AllocatableResource`'s
  `SmartContractAllowance` value carry it too. The
  `DerivationIndex` type is exported from host and signer. The release also
  brings the host's new sr25519 `account.signVrf` API (not yet wrapped by an SDK
  accessor).

### Patch Changes

- bffc04a: Update `@parity/truapi` to 0.5.1. No SDK API changes; the embedded sandbox
  client gains a fallback for legacy iframe hosts that don't yet answer the
  `truapi-ready` / `truapi-init` MessagePort handoff (it recognizes their
  first raw frame instead), and reports a real `"connecting"` status while
  waiting for the host channel.

## 0.14.1

### Patch Changes

- 8ab88ba: Use the TrUAPI transport subscription ID for PAPI ChainHead follow-up requests.

## 0.14.0

### Minor Changes

- c3fccfa: **Breaking: remove the Summit Network (Web3 Summit) environment.**

  The Summit event is over and its chains are being decommissioned. Removes
  the `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
  descriptors, `"summit"` from `Environment` / `CloudStorageEnvironment`
  (`getChainAPI("summit")` and `CloudStorageClient.create({ environment:
"summit" })` no longer compile), the `CloudStorageNetworks.summit` preset,
  and `BULLETIN_RPCS.summit`. `paseo` and `devnet` are unaffected.

- c3fccfa: **Update `@parity/truapi` to 0.5.0 (versioned call errors, CoinPayment, Ring
  VRF redesign).**

  truapi 0.4 wraps every call error in its canonical `CallErrorValue`
  envelope: domain failures arrive as `{ tag: "Domain", value: { tag: "V1",
value: <domain error> } }`, alongside the transport-level `Denied` /
  `Unsupported` / `MalformedFrame` / `HostFailure` variants. truapi 0.5
  reworks the Ring VRF surface around product-scoped proof contexts. The SDK
  tracks the protocol:

  - `AccountsProvider` lookup methods now carry
    `CallErrorValue<Versioned…Error>` on their `err` channel instead of the
    bare per-domain error unions.
  - `HostErrorPayload` is now the `CallErrorValue` envelope itself
    (protocol-sourced, replacing the previous hand-widened union), and
    `formatHostError` / `HostCallFailedError` messages unwrap the `Domain`
    envelope down to the domain error, so rendered messages read as before.
  - **Ring VRF**: `getProductAccountAlias` and `createRingVRFProof` (on
    `AccountsProvider`, `SignerManager`, and the signer's `HostProvider`)
    now take a `ProductProofContext` (`{ productId, suffix }`) plus the
    restructured `RingLocation` (`{ chainId, junctions }`) — the host
    selects the ring member key, so per-account `dotNsIdentifier` /
    `derivationIndex` addressing is gone. `createRingVRFProof` returns a
    `RingVRFProof` (`{ proof, contextualAlias, ringIndex, ringRevision }`)
    instead of bare proof bytes, carrying the values needed to verify the
    proof downstream.
  - `PaymentManager` purse parameters follow truapi's rename of
    `PaymentPurseId` to `CoinPaymentPurseId` (same underlying type).
  - The `createFakeTruApiClient` test fake covers the new `coinPayment`
    domain as an unmodeled (throwing) surface and the richer Ring VRF proof
    response.

## 0.13.0

### Minor Changes

- cb0098f: **Add `devnet` — the public Paseo-testnet products devnet — as a new environment.**

  Adds `devnet-asset-hub`, `devnet-bulletin`, and `devnet-individuality` (the
  People chain) descriptors, generated against the community-run Paseo system
  chains (Asset Hub 1000, People 1004, Bulletin 1010), and wires `devnet`
  through the host Bulletin RPC list, the cloud-storage network preset, and
  `getChainAPI("devnet")`. Unlike `paseo` — which targets the Paseo Next v2
  deployment — `devnet` targets the long-lived public Paseo testnet. Purely
  additive — no existing environment, descriptor, or endpoint changes.

- cb0098f: **Ship dev-only test fakes under a new `/testing` subpath on each package.**

  Each package now exports a working in-memory fake of its interface from a
  dedicated `/testing` entry, so SDK-dependent app code can be unit-tested with no
  host container, chain, or wallet:

  - `@parity/product-sdk-local-storage/testing` — `createFakeHostLocalStorage`
  - `@parity/product-sdk-signer/testing` — `createFakeSignerProvider`, `fakeSignerAccount`
  - `@parity/product-sdk-statement-store/testing` — `createFakeStatementTransport`
  - `@parity/product-sdk-contracts/testing` — `createFakeContractRuntime`, `fakeDryRunResult`
  - `@parity/product-sdk-host/testing` — `createFakeTruApiClient`, `createFakeHost`, `setTruApiClient`
  - `@parity/product-sdk/testing` — `createFakeApp`, plus re-exports of the
    local-storage, signer, contracts, and host fakes

  The fakes are framework-agnostic, live behind separate build entries, and are
  absent from every package's main entry, so production bundles are unaffected.
  `@parity/product-sdk-host` additionally gains a module-level test seam
  (`setTruApiClient`, exposed only through `/testing`) that the host accessors
  consult before the sandbox client; it defaults to `null`, so production
  behavior is unchanged.

  See the new "Testing your app" guide in the docs for usage.

### Patch Changes

- cb0098f: Introduce an SDK-wide `Result` error model: fallible operations across the
  `@parity/product-sdk-*` packages now return a typed `Result<T, E>` instead of
  throwing, so consumers branch on `r.ok` and get typed errors on the `err`
  channel. See the `guides/migrating-to-result` migration guide.

  **New package — `@parity/result`:** a generic, domain-agnostic, zero-dependency
  leaf exporting `Result<T, E>` (`{ ok: true; value } | { ok: false; error }`),
  `ok()` / `err()`, `normalizeError(cause, ErrorClass)` (coerce a caught value to a
  typed error — the single error-normalization strategy, replacing ad-hoc `as`
  casts), `isErrorOf(e, ErrorClass)` (generic `instanceof` guard), and
  `unwrapOk` / `unwrapErr` (framework-agnostic test/script assertions). It carries
  no product-sdk specifics, so it can be embedded anywhere.

  **New package — `@parity/product-sdk-errors`:** a zero-dependency leaf holding
  the product-sdk-specific cross-package `SdkError` marker interface +
  `isSdkError(e)` guard. Every package's base error implements the marker (with a
  `source` string like `"tx"`), so `isSdkError(e)` recognizes any SDK-origin error
  without importing per-package classes. `@parity/product-sdk` re-exports `Result` /
  `ok` / `err` / `isErrorOf` from `@parity/result` and `SdkError` / `isSdkError`
  from `@parity/product-sdk-errors`.

  **Breaking — these now return `Result` instead of throwing:**

  - `@parity/product-sdk-tx`: `submitAndWatch`, `batchSubmitAndWatch` → `Result<TxResult, TxError>`; `ensureAccountMapped` → `Result<TxResult | null, TxError>` (`ok(null)` = already mapped); `extractTransaction` → `Result<SubmittableTransaction, TxDryRunError>` (sync). `TxAccountMappingError` now extends `TxError`.
  - `@parity/product-sdk-contracts`: `contract.<method>.tx` → `Result<TxResult, ContractError | TxError>`; `.prepare` → `Result<BatchableCall, ContractError>`; `withLiveContractAddresses` and `ContractManager.fromLive` / `fromLiveClient` → `Result<…, ContractError>`; `ensureContractAccountMapped` → `Result<TxResult | null, TxError>`. **`contract.<method>.query` is unchanged** — it keeps returning `QueryResult<T>`, since a dry-run revert is an expected outcome (a value), not an error.
  - `@parity/product-sdk-cloud-storage`: `queryBytes`, `queryJson`, `executeQuery`, `checkAuthorization`, `verifyStored` (`ok(null)` = not recorded at that block), `authorizeAccount`, and the equivalent `CloudStorageClient` read methods (`fetchBytes` / `fetchJson` / `checkAuthorization` / `verifyStored`). The `CloudStorageClient` methods that forward to the upstream client (`store`, `authorizePreimage`, `renew`, `estimateAuthorization`, and the `authorizeAccount` _method_) are unchanged.
  - `@parity/product-sdk-statement-store`: `StatementStoreClient.publish` and `ChannelStore.write` → `Result<void, StatementStoreError>` (were `Promise<boolean>`). The old boolean swallowed the failure reason into `false`; the `Result` now carries it (`StatementConnectionError`, `StatementDataTooLargeError`, `StatementSubmitError`). **Note:** a bare `if (result)` now always passes (a `Result` object is truthy) — audit call sites for `.ok`.
  - `@parity/product-sdk` umbrella: `createApp().cloudStorage.upload` / `fetch` now return `Result` (`computeCid` unchanged — pure).

  `@parity/product-sdk-host` and `@parity/product-sdk-signer` (whose public
  operations already returned `Result`) migrate onto the shared `@parity/result`
  package and adopt the `SdkError` marker from `@parity/product-sdk-errors`; no
  further API change.

  **Unchanged everywhere:** pure/sync helpers and factories, build-time codegen,
  lifecycle methods, and subscription APIs continue to throw or return their
  existing types — `Result` is reserved for fallible runtime operations.

- Updated dependencies [cb0098f]
  - @parity/result@0.2.0
  - @parity/product-sdk-errors@0.2.0

## 0.12.0

### Minor Changes

- f81fc2b: Move the throw→`Result` boundary into `@parity/product-sdk-host`: the flat public host operations now return a tagged `Result<T, HostError>` instead of throwing opaque `Error`s, so every consumer gets typed errors (not just the signer, which previously wrapped host's throws in its own `try/catch`).

  **New exports (`@parity/product-sdk-host`):**

  - `Result<T, E>` (`{ ok: true; value } | { ok: false; error }`) plus `ok()` / `err()` constructors. The shape is intentionally identical to `@parity/product-sdk-signer`'s `Result`, so the two layers compose with no adapter.
  - A `HostError` class hierarchy — `HostError` (base, extends `Error`), `HostUnavailableError` (raised when running outside a host container), and `HostCallFailedError` (a host call reached the container but failed; carries the structured truapi error as `.payload` and as `cause`) — plus an `isHostError(e)` type guard. The hierarchy mirrors the signer's error classes, so `instanceof HostUnavailableError` works across both layers.

  **Breaking (shape) changes — minor-bumped because the package is pre-1.0:**

  - These functions now return `Promise<Result<T, HostError>>` instead of throwing: `requestPermission`, `requestDevicePermission`, `requestResourceAllocation`, `createProofAuthorized`, `deriveEntropy`, `navigateTo`, `broadcastTransaction`, `stopTransaction`, `featureSupported`, `isChainSupported`. Migrate `const x = await foo()` (which threw on failure) to `const r = await foo(); if (!r.ok) handle(r.error); const x = r.value`.
  - `getChainSpec` now returns `Promise<Result<ChainSpec | null, HostError>>`. `ok(null)` still means "running outside a host container" (an expected state, not a failure); a real host-call failure now surfaces on the `err` channel instead of throwing. Migrate `const spec = await getChainSpec(h); if (spec) …` to `const r = await getChainSpec(h); if (r.ok && r.value) …`.
  - The exported error-payload type **`HostError` is renamed to `HostErrorPayload`** (the structured truapi `Err`-channel shape), freeing the name `HostError` for the new base error class. The payload now rides inside `HostCallFailedError.payload`.

  **Unchanged:**

  - The feature-detection getters that return `T | null` (`getThemeProvider`, `getAccountsProvider`, `getHostProvider`, `getHostLocalStorage` / `createHostLocalStorage`, `getStatementStore`, `getPreimageManager` / `createHostPreimageManager`, `getChatManager`, `getNotificationManager`, `getPaymentManager`) keep their `T | null` signatures. Their throwing lives in the methods of the adapter objects they return — some of which implement external interfaces (e.g. polkadot-api's `JsonRpcProvider`) whose signatures can't carry a `Result` — so those methods keep the throw convention via the retained internal `unwrapHostResult` helper.

  **`@parity/product-sdk-signer` (patch):** internal only — the public API is unchanged. `HostProvider`'s default `requestChainSubmitPermissionFn` and `SignerManager`'s `ConnectContext.requestResourceAllocation` now adapt host's `Result`-returning functions back to their existing `Promise<boolean>` / `Promise<AllocationOutcome[]>` contracts (unwrap-or-throw at the boundary), so consumer callbacks see no change.

- f81fc2b: Migrate `@parity/product-sdk-host`'s host-API surface — plus the statement store, preimage, and the signer's host provider — from the third-party `@novasamatech` packages to the in-house `@parity/truapi` client, and drop `@novasamatech/sdk-statement` from `@parity/product-sdk-statement-store`.

  A new sandbox-bootstrap module detects the host environment (iframe / webview / injected message port), builds the `@parity/truapi` transport, creates the client, and runs the `system.handshake` — replacing the wrapper's auto-detected `hostApi` singleton. `@parity/truapi` is now a hard runtime dependency of `host` (alongside `neverthrow`, `@polkadot-api/json-rpc-provider`, and `@polkadot-api/substrate-bindings`). With the accounts/signer surface migrated, **nothing in `host` or `signer` imports `@novasamatech/host-api-wrapper` / `host-api` at runtime anymore.**

  **Migrated to `@parity/truapi`:** `getTruApi`, `requestResourceAllocation`, `requestPermission`, `requestDevicePermission`, `deriveEntropy`, `getHostLocalStorage` / `createHostLocalStorage` (adapted onto `localStorage.read/write/clear`), `isInsideContainer` / `isInsideContainerSync`, `getStatementStore` + `createProofAuthorized` (`statementStore.*`), `getPreimageManager` / `createHostPreimageManager` (`preimage.*`), `getThemeProvider` (`theme.*`), `getChatManager` (`chat.*`), `getPaymentManager` (`payment.*`), `getNotificationManager` (`notifications.*`), `navigateTo` (`system.navigateTo`), `featureSupported` / `isChainSupported` (`system.featureSupported`), `getChainSpec` (`chain.getSpec*`), `broadcastTransaction` / `stopTransaction` (`chain.*`), `getHostProvider` (the PAPI `JsonRpcProvider`, over `chain.*` + `system.featureSupported`), and `getAccountsProvider` (over `account.*` + `signing.*`).

  The `getNotificationManager`, `navigateTo`, `featureSupported` / `isChainSupported`, `getChainSpec`, and `broadcastTransaction` / `stopTransaction` wrappers were re-pointed from the flat novasama `hostApi` onto the namespaced truapi client (`system.*` / `chain.*` / `notifications.*`); their public Promise-shaped signatures are unchanged. `PushNotificationError` is now the `@parity/truapi` `{ tag }` tagged union (`"ScheduleLimitReached"` / `"Unknown"`) rather than a SCALE codec — branch on `(err as Error).cause` (the rejected `Error` carries the host error as its `cause`) instead of `instanceof`.

  The PAPI provider is built by a new `papi-provider` module — a backport of `@novasamatech/host-api-wrapper`'s `createPapiProvider` into product-sdk, with the per-method calls re-pointed at `truApi.chain.*`. It bridges PAPI's JSON-RPC `chainHead` / `chainSpec` / `transaction` API to the host's structured calls (request dispatch, `chainHead_v1_followEvent` synthesis, synthetic follow-subscription ids, operation/broadcast bookkeeping). Unlike the upstream it needs no `getSyncProvider` deferral or no-op fallback: `getHostProvider` is async and runs the chain-support gate (throwing `ChainNotSupportedError`) before the provider is built. `getHostProvider`'s signature and `ChainNotSupportedError` behavior are unchanged.

  **Accounts + signer.** `getAccountsProvider` moves to a new `accounts` module — a backport of the wrapper's `createAccountsProvider`, with lookups/proofs re-pointed onto `truApi.account.*` and the `PolkadotSigner` factories (`getProductAccountSigner` / `getLegacyAccountSigner`) built over `truApi.signing.*`. The account types (`HostAccount`, `ProductAccount`, `ContextualAlias`, `AccountsProvider`, plus a re-exported `RingLocation`) now live in `accounts` and are derived from / re-exported alongside `@parity/truapi`. The provider's public method surface and the `PolkadotSigner` behavior (metadata-driven `txExtVersion`, signed-extension mapping, the `createTransaction` vs deprecated `signPayload` modes) are preserved.

  `@parity/product-sdk-signer`'s `HostProvider` now consumes `host`'s `getAccountsProvider` instead of dynamically importing the wrapper, and requests the `ChainSubmit` permission via `host`'s `requestPermission` (`truApi.permissions`, plain `{ tag }` shapes) — so the wrapper-shaped loader indirection (`loadSdk` / `loadHostApiEnum` / the `host-api` `RemotePermission` enum constructors) is gone. `HostProviderOptions` swaps the internal `loadSdk` / `loadHostApiEnum` hooks for `loadAccountsProvider` / `requestChainSubmitPermissionFn`; the public `connect()` / account / signer behavior is unchanged.

  **Still on `@novasamatech/host-api-wrapper`:** nothing in `host` / `signer`. (The `terminal` package's separate `@novasamatech/host-papp` / `statement-store` / `storage-adapter` deps are out of scope.)

  **Removed:** chat custom-message rendering — `matchChatCustomRenderers`, `getChatManager().onCustomMessageRenderingRequest`, and the `ChatCustomMessageRenderer` / `ChatCustomMessageRendererParams` types. `@parity/truapi` models custom render as a different, currently-stubbed client subscription with no product-as-renderer primitive; this will be reintroduced when that flow lands. The chat / theme / payment types (`ChatRoom`, `ChatMessageContent`, `ChatReceivedAction`, `ChatRoomRegistrationResult` / `ChatBotRegistrationResult`, `ThemeMode` / `ThemeName` / `ThemeVariant`, `PaymentBalance`, `PaymentStatus`, `TopUpSource`) are now re-exported from `@parity/truapi` — proofs/statuses use `{ tag }`, and `PaymentStatus` / `TopUpSource` follow the truapi shapes.

  **`@parity/product-sdk-host` breaking (shape) changes** — minor-bumped because the package is pre-1.0:

  - **`TruApi` / `getTruApi()`** now resolve to the namespaced `@parity/truapi` `TrUApiClient` instead of the flat novasama `hostApi`. Direct callers move from e.g. `truApi.permission(enumValue("v1", p))` to `truApi.permissions.requestRemotePermission({ permission: p })`, and `truApi.navigateTo(url)` to `truApi.system.navigateTo({ url })`.
  - **`AllocationOutcome`** is now the string union `"Allocated" | "Rejected" | "NotAvailable"` (previously a tagged enum). Inspect with `outcome === "Allocated"` rather than `outcome.tag === "Allocated"`.
  - **`AllocatableResource`, `RemotePermission`, `DevicePermissionKind`** are derived from `@parity/truapi` types; variant tags are unchanged, except `DevicePermissionKind` is now a string union (`"Camera"`, `"Microphone"`, …).
  - **`HostLocalStorage`** is now an explicit interface (`readString` / `writeString` / `readJSON` / `writeJSON` / `readBytes` / `writeBytes` / `clear`); method signatures unchanged.
  - **Statement types** (`Statement`, `SignedStatement`, `StatementProof`, `Topic`, `ProductAccountId`, `StatementTopicFilter`, `StatementsPage`) are re-exported from `@parity/truapi`: fields are `0x`-prefixed `HexString`s, proofs use `{ tag: "Sr25519" }`, and `ProductAccountId` is `{ dotNsIdentifier, derivationIndex }`. `HostStatementStore` exposes `subscribe` / `createProofAuthorized` / `submit`. `HostSubscription` is an explicit `{ unsubscribe; onInterrupt }` interface.
  - New exported helper **`unwrapHostResult(result, label)`** collapses the repeated `ResultAsync.match(ok, err ⇒ throw)` pattern across the host wrappers.

  Host-error formatting (`formatHostError`) now reads `@parity/truapi`'s error shapes (`GenericError`'s `reason`, tagged-variant reasons, unit tags) while still unwrapping the legacy novasama envelope for the surfaces on the wrapper.

  **`@parity/product-sdk-statement-store`:**

  - Drops the `@novasamatech/sdk-statement` dependency and the `@novasamatech/host-api-wrapper` peer/dev dependency.
  - The statement value types are now **derived** from the `@parity/truapi` wire types (`Statement = Omit<WireStatement, "data"> & { data?: Uint8Array }`), so protocol changes propagate automatically; `Proof` / `Topic` are re-exported verbatim. The only intentional difference is `data` (decoded `Uint8Array` vs the wire hex string). `createExpiry` and the ergonomic `TopicFilter` (`"any" | matchAll | matchAny`) remain local; the unused `SubmitResult` type is removed.
  - **Behavior change:** host-mode submission now uses the RFC-10 sponsored path (`createProofAuthorized`) — statements are signed by the product's allowance account rather than a per-call account. The host-mode `accountId` credential is no longer used (now optional, ignored if supplied).

  Submitted statements are unchanged on the wire; only the TypeScript surface and the signing account change. No consumer code changes are required beyond dropping any direct `@novasamatech/sdk-statement` imports in favor of `@parity/product-sdk-statement-store`.

- f81fc2b: Remove the last PolkadotJS (`polkadot-api/pjs-signer`) dependency from the host account signer factories. `getLegacyAccountSigner` now builds a PAPI `PolkadotSigner` directly over `truApi.signing.createTransactionWithLegacyAccount` / `signRawWithLegacyAccount`, mirroring the product-account `createTransaction` path, so opaque signed extensions (e.g. Paseo Next's `AsPgas`) survive end-to-end for legacy accounts too.

  `getProductAccountSigner` drops its `signerType` parameter — the deprecated `"signPayload"` (PJS-bridge) mode is gone; product-account signing always uses the host's `createTransaction` path. The signer's `HostProvider` no longer passes a signer type.

## 0.11.0

### Minor Changes

- ef14a41: **Add typed wrappers for the host's navigation, feature-probe, chain-spec, and transaction-broadcast TruAPI calls.**

  These raw `hostApi.*` methods previously required `getTruApi()` plus a manual `enumValue("v1", ...)` wrap and neverthrow `ResultAsync` unwrap. They now have thin, fully-typed wrappers in `@parity/product-sdk-host` (re-exported from `@parity/product-sdk/host`), matching the throw-on-error / return-null conventions of the existing `requestPermission`, `deriveEntropy`, and `getThemeProvider` helpers.

  ### New public API

  - `navigateTo(url: string): Promise<void>` — deep-link / external navigation. Throws on `NavigateToErr::PermissionDenied` / `::Unknown`.
  - `featureSupported(feature: Feature): Promise<boolean>` and `isChainSupported(genesisHash: HexString): Promise<boolean>` — probe host feature/chain support. `Feature` is `{ tag: "Chain"; value: HexString }`.
  - `getChainSpec(genesisHash: HexString): Promise<ChainSpec | null>` — fetches genesis hash, chain name, and properties in one concurrent call. Returns `null` outside a container. `ChainSpec` carries `{ genesisHash, name, properties: ChainProperties | null, propertiesRaw: string }`; `properties` is the host's properties JSON parsed into `{ ss58Format?, tokenDecimals?, tokenSymbol?, [k]: unknown }`, with `propertiesRaw` preserving the original string (and `properties === null` when the JSON can't be parsed).
  - `broadcastTransaction(genesisHash: HexString, transaction: HexString): Promise<string | null>` — broadcast a signed tx; resolves to the operation id (or `null`).
  - `stopTransaction(genesisHash: HexString, operationId: string): Promise<void>` — stop an in-flight broadcast.

  All wrappers throw `"<fn>: TruAPI unavailable"` when running outside a host container, except `getChainSpec`, which returns `null` to match the sibling `get*` getters.

## 0.10.3

### Patch Changes

- 8dd1232: chore(deps): bump polkadot-api to 2.1.6

  Updates the `polkadot-api` catalog entry `^2.1.5` → `^2.1.6` (2.1.6 carries the
  double-notification fix). Every published package resolves `polkadot-api`
  through `catalog:`, so each one's published `dependencies` range moves to
  `^2.1.6`. There is no source change in any package — these are patch bumps to
  ship the new floor via the published `catalog:` resolution.

  Releases the catalog bump from #223, which was merged to `main` without a
  changeset.

## 0.10.2

### Patch Changes

- c39332e: chore(deps): bump @novasamatech/\* host SDKs to 0.8.9

  Update the upstream host-API SDKs to the 0.8.9 release:

  - catalog: `@novasamatech/host-api` and `@novasamatech/host-api-wrapper` `^0.8.8` → `^0.8.9`
  - terminal: `@novasamatech/host-papp`, `@novasamatech/statement-store`, `@novasamatech/storage-adapter`, and `@novasamatech/substrate-slot-sr25519-wasm` `^0.8.8` → `^0.8.9`

  `@novasamatech/sdk-statement` is unaffected (separate package, latest is 0.6.0).

## 0.10.1

### Patch Changes

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

## 0.10.0

### Minor Changes

- acb2228: **Make `@novasamatech/*` runtime dependencies instead of optional peer dependencies.**

  `@parity/product-sdk-host` now declares `@novasamatech/host-api` and
  `@novasamatech/host-api-wrapper` as regular `dependencies` (via the existing `catalog:`
  range) rather than optional `peerDependencies`. `host-api` was always required at runtime
  — its `enumValue` is statically imported by the published bundle — so the optional-peer
  declaration was incorrect; `host-api-wrapper` is loaded lazily by the host bridge and is
  now pulled transitively too. Consumers can reach the host APIs purely through
  `@parity/product-sdk-host` with no direct `@novasamatech/*` dependency of their own.

### Patch Changes

- acb2228: **Bump `@novasamatech/host-api` family from `^0.8.7-2` to `^0.8.7` (stable).**

  Stable `0.8.7` is now published across the family (`host-api`, `host-api-wrapper`, `host-papp`, `statement-store`, `storage-adapter`, `substrate-slot-sr25519-wasm`). This bump removes the prerelease specifier from the published artifact — consumers see a cleaner semver range and get the same upstream code we've been testing against.

  ### Delta vs `0.8.7-2`

  - **`MAX_SSO_REQUEST_SIZE` raised** in `host-papp`: 256 KiB → 500 KiB. Larger Mobile-SSO statements now flow without splitting.
  - **`ExpiryTooLowError` / `AccountFullError` constructors** in `statement-store` accept `bigint` instead of `number`. Internal — our code doesn't construct these directly.
  - **New additive exports** in `statement-store`: `PRIORITY_EPOCH_OFFSET`, `createExpiryAllocator`, `ExpiryAllocator`, `submitWithRetry`, `isPriorityTooLow`, `SubmitRetryOptions`, `signAndSubmitStatement`, `submitStatementOnce`, `SubmitStatementParams`. Not consumed by product-sdk; opt-in for downstream callers.
  - **No session/secrets codec changes.** The `testing.ts` codec mirror in `@parity/product-sdk-terminal` continues to round-trip through the real `SsoSessionManager` and `UserSecretRepository` against 0.8.7 — both interop tests pass.

  No public API change on the product-sdk side; no migration needed.

## 0.9.0

### Minor Changes

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

## 0.8.0

### Minor Changes

- a2fd276: **Add the Summit Network (Web3 Summit) as a new environment.**

  Adds `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
  (the People chain) descriptors, and wires `summit` through the host
  Bulletin RPC list, the cloud-storage network preset, and
  `getChainAPI("summit")`. Purely additive — no existing environment,
  descriptor, or endpoint changes.

## 0.7.1

### Patch Changes

- d4bc935: Bump `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, and `@novasamatech/storage-adapter` from `^0.8.5` to `^0.8.6`.

  0.8.6 lands RFC-0007 (PR #205 upstream — derive product entropy from `rootEntropySource`) and a `polkadot-api` bump to `2.1.6` (double-notification fix). The RFC-0007 work changes the on-disk session and secrets schemas:

  - **Session** (`SsoSessions` → `SsoSessionsV2`): dropped the `Option` wrapper on `identityAccountId`, `identityChatPublicKey`, and `ssoEncPubKey` (all now required); appended `rootEntropySource: Bytes(32)` for the host's `host_derive_entropy` handler.
  - **Secrets** (`UserSecrets` → `UserSecretsV2`): dropped `entropy` (now lives on the session as `rootEntropySource`); added the V2 `identityChatPrivateKey: Bytes(32)`.
  - **Graceful-degrade removed.** Old-shape blobs no longer fall back to empty — they now throw at decode. A CLI on 0.8.5 disk state will need to re-pair after the consumer upgrades.

  `host-api` and `host-api-wrapper` had no source changes in 0.8.6 (lockstep version tag only) — `host`, `signer`, and `statement-store` are patch-bumped to signal "tested against 0.8.6" via published peer-dep / catalog resolution; their runtime behavior is unchanged.

  In `@parity/product-sdk-terminal`, the internal codec mirror for `createTestSession` was updated to match the 0.8.6 session and secrets shapes — including the storage-key rename to `*V2` — so synthesized test sessions round-trip cleanly through the real 0.8.6 `SsoSessionManager` / `UserSecretRepository`. No public-API change in any of the four packages.

## 0.7.0

### Minor Changes

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

## 0.6.1

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

## 0.6.0

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

## 0.5.0

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

### Patch Changes

- 7610e61: **Bump `@novasamatech/host-api-wrapper` and `@novasamatech/host-api` to `^0.7.9` (stable).**

  `0.7.9` is the first stable release on the `0.7.9` line. The previous catalog pinned the `0.7.9-6` prerelease exactly (no caret); this bump relaxes both entries to `^0.7.9` so the auto-bumper (`product-sdk-deps-check.yml`) can pick up future patch releases automatically.

  No source-level changes for consumers — `0.7.9` is the same API surface as the prereleases we were already shipping against.

## 0.4.0

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

## 0.3.0

### Minor Changes

- bdeb144: **Add `requestResourceAllocation` to `@parity/product-sdk-host`.**

  Exposes a typed wrapper around the TruAPI's resource-allocation endpoint, so consumers can pre-allocate one or more resource allowances in a single host-side user prompt. Subsequent operations covered by the granted allowance don't re-prompt the user.

  ### New surface

  ```ts
  import {
    requestResourceAllocation,
    type AllocatableResource,
    type AllocationOutcome,
  } from "@parity/product-sdk-host";

  const outcomes = await requestResourceAllocation([
    { tag: "BulletInAllowance", value: undefined },
  ]);
  if (outcomes[0].tag === "Allocated") {
    // allowance granted
  }
  ```

  - `AllocatableResource` and `AllocationOutcome` are derived from the upstream codecs (`@novasamatech/host-api`) via `CodecType`, so variant renames upstream surface as compile errors rather than runtime failures.
  - The host strips secret payloads from `Allocated` outcomes before returning, so `value` is always `undefined` on the product side.
  - Throws if the TruAPI is unavailable (consistent with the rest of the host module's accessors).

  No breaking changes — purely additive.

## 0.2.2

### Patch Changes

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

## 0.2.1

### Patch Changes

- 5d81610: **Bump `@novasamatech/product-sdk` and `@novasamatech/host-api` to `^0.7.8`.**

  Picks up the latest novasama patch release. Catalog-pinned (`pnpm-workspace.yaml`), so the three consumer packages — `host`, `signer`, and `statement-store` — pick up the new version transitively. No source changes required in this SDK; the upstream patch is backwards-compatible at the API surface novasama exposes to us.

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
  - @parity/product-sdk-logger@0.1.1

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-logger@0.1.0
