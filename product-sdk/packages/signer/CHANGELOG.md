# @parity/product-sdk-signer

## 0.14.0

### Minor Changes

- f987fd7: **Preserve the underlying host error as `cause` on `HostRejectedError` (#289).**

  Six of the seven `HostProvider` account methods discarded the host's own error once they
  had formatted it into a message, so a signer-layer consumer could only recover the reason
  by matching on the message text. They now pass it through, and `HostRejectedError` accepts
  it as a third optional `ErrorOptions` argument, the same way `SigningFailedError` and
  `AllowanceExpiredError` already did.

  `error.cause` is the raw TrUAPI envelope, untouched — `scale.CallErrorValue<Versioned…Error>`
  for the call that failed. Its tagged union narrows exhaustively and already separates a
  domain rejection from a transport failure, so no hand-written gate is needed to tell the
  two apart:

  ```ts
  import type {
    scale,
    VersionedHostAccountCreateProofError,
  } from "@parity/truapi";
  import { isErrorOf } from "@parity/result";

  const result = await manager.createRingVRFProof(
    handle,
    context,
    ring,
    message
  );
  if (!result.ok && isErrorOf(result.error, HostRejectedError)) {
    const raw = result.error
      .cause as scale.CallErrorValue<VersionedHostAccountCreateProofError>;
    if (raw.tag === "Domain" && raw.value.value.tag === "NotAllowlisted") {
      // Degrade: this host has no allowlist source yet.
    }
  }
  ```

  `NotAllowlisted` on a cross-product proof or `ringVrfSign` is the expected steady-state
  answer on core-based hosts rather than a fault — the gate compares the key handle's owner
  against the calling product and reads no manifest, so no allowlist entry can exist yet
  (paritytech/host-rust-core#373). Android prompts and succeeds on the same request, so a
  product spanning both needs to branch on this to degrade per host.

  Covers `registerRingVrfKey`, `listRingVrfKeys`, `getProductAccountAlias`,
  `createRingVRFProof`, `getUserId`, `signVrf` and `getProductAccount`. A provider method
  that throws instead of rejecting keeps its own error on `cause` rather than losing it,
  which is the shape a host predating a call fails in.

  **`nonTransient` now answers consistently, which is a behaviour change.** It is classified
  from the host's error at every method instead of only at `getProductAccount`, so a signed-out
  host (`NotConnected`) reports `nonTransient: true` from `registerRingVrfKey`,
  `listRingVrfKeys`, `getProductAccountAlias`, `createRingVRFProof`, `getUserId` and `signVrf`,
  where it previously reported `false`. Those six could not classify before, because the error
  they needed had already been discarded. If you branch on `nonTransient`, a signed-out user now
  reaches your read-only path on all seven calls rather than one, which is what the field is
  documented to mean. Nothing inside the SDK changes behaviour: its one internal reader takes
  its value from `getProductAccount`, which already classified correctly.

  `HostUnavailableError` also takes an optional `ErrorOptions` now, and a failed
  accounts-provider load carries the error the loader threw, instead of only its message text.

  Reading `cause` at this layer means depending on `@parity/truapi` for the cast. Consumers
  wanting fully-typed handling without one should call `getAccountsProvider()` from
  `@parity/product-sdk-host`, where TrUAPI's types already flow through untouched — the same
  place `ringVrfSign` and `findRingVrfKeyHandle` live.

### Patch Changes

- f987fd7: **Removed: `deriveContextAlias`, `verifyContextAlias`, `ContextAliasInfo`.**

  Deprecated in `0.22.0`, which named `0.23.0` as the removal version. This is that release.

  `deriveContextAlias` returned addresses no key can spend: the alias public key was
  `blake2b256(parentPublicKey || context)`, a hash rather than a derived key, so no secret
  corresponded to the SS58 address or to the H160. Both could receive value and neither could ever
  send it. `verifyContextAlias` compared two public values, so a `true` result showed a derivation
  relationship and never that anyone controlled either account.

  Replace by intent:

  - An account that holds or spends value: `SignerManager.getProductAccount(dotNsIdentifier, index)`
    from `@parity/product-sdk-signer`. Host backed and actually signable.
  - The address offline, with no host: `deriveProductAccountPublicKey` from
    `@parity/product-sdk-keys`, the canonical sr25519 soft derivation.
  - An unlinkable per-context alias: select a registered ring VRF key, then
    `SignerManager.getProductAccountAlias(keyHandle, context, location)` or
    `createRingVRFProof(keyHandle, context, location, message)`.
  - A context-scoped identifier that was never an account: `blake2b256` from
    `@parity/product-sdk/crypto`. Same bytes, without the address packaging that invited the mistake.

  If you used an alias purely as an opaque identifier, the same 32 bytes are still available as
  `blake2b256(parentPublicKey || context)`. That is the hash, not either address form the old helper
  returned, so re-encode to match what you stored: `ss58Encode(blake2b256(...), 42)` reproduces the
  old `address`, and `deriveH160(blake2b256(...))` reproduces the old `h160Address`. Both are exact.

- Updated dependencies [f987fd7]
  - @parity/product-sdk-address@0.2.0
  - @parity/product-sdk-keys@0.3.20

## 0.13.0

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

### Patch Changes

- 3655724: **Deprecate the context-alias helpers, delete the unimplemented ring-alias stubs (#287).**

  `deriveContextAlias` returns addresses that can receive value and can never spend it: the alias
  public key is `blake2b256(parentPublicKey || context)`, a hash rather than a derived key, so no
  secret corresponds to the SS58 address or the H160. The address encodes and validates fine, so
  nothing surfaces until value arrives at it.

  **Deleted:** `deriveAnonymousAlias`, `createRingProof`, `verifyRingProof`, `AnonymousAliasInfo`,
  and identity's `RingLocation`. Each function was a debug log followed by an unconditional
  `throw`, with no branch or early return, so no working consumer could exist and this break is
  compile-time only. The real ring VRF operations already live on `SignerManager` in
  `@parity/product-sdk-signer` as `getProductAccountAlias(keyHandle, context, location)` and
  `createRingVRFProof(keyHandle, context, location, message)`, host-backed and using an opaque
  registered key handle selected by ring. Identity's `RingLocation` was also the wrong shape,
  `{ringIndex, memberIndex}` against the protocol type `{chainId, junctions}`.

  **Deprecated, removal in `@parity/product-sdk` 0.23.0:** `deriveContextAlias`,
  `verifyContextAlias`, `ContextAliasInfo`. Their output is unchanged, so a caller using an alias as
  a plain identifier has a release to migrate. `verifyContextAlias` compares two public values with
  no secret involved anywhere, so it confirms a derivation relationship and authenticates nothing.

  The derivation output is deliberately unchanged: the same name and signature returning different
  bytes would break identifier consumers silently, with no compile error.

  ### Migration

  | If you used it for                                    | Use instead                                                                                                                                                                                                      |
  | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | An account that holds or spends value                 | `SignerManager.getProductAccount(dotNsIdentifier, index)` from `@parity/product-sdk-signer`                                                                                                                      |
  | The address offline, with no host                     | `deriveProductAccountPublicKey` from `@parity/product-sdk-keys`, the canonical sr25519 soft derivation                                                                                                           |
  | An unlinkable per-context alias                       | Select a registered key by ring, then call `SignerManager.getProductAccountAlias(keyHandle, context, location)` or `createRingVRFProof(keyHandle, context, location, message)` from `@parity/product-sdk-signer` |
  | A context-scoped identifier, never used as an account | `blake2b256` from `@parity/product-sdk/crypto`: the same bytes, without address packaging                                                                                                                        |

  The DotNS half of `./identity` is unaffected (`resolveDotNs`, `reverseDotNs`, `isDotNsAvailable`,
  `resolvePeopleUsernameOwner` and the name helpers), and the subpath itself is not deprecated.

  `@parity/product-sdk-signer` takes a patch here for the context-alias migration wording. The
  separate TrUAPI 0.9 changeset documents the `RingLocation` type break and supplies the release's
  minor bump.

- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
  - @parity/product-sdk-host@0.16.0
  - @parity/product-sdk-keys@0.3.19

## 0.12.1

### Patch Changes

- Updated dependencies [70c30f3]
  - @parity/product-sdk-host@0.15.1
  - @parity/product-sdk-keys@0.3.18

## 0.12.0

### Minor Changes

- bffc04a: Typed `AllowanceExpiredError` for signs that fail on a lapsed allowance.

  New `AllowanceExpiredError` in `@parity/product-sdk-signer` (extends
  `SignerError`, so it carries the shared `SdkError` marker; `.resource` names
  the lapsed allowance, `.cause` holds the underlying failure). The terminal
  session signers (`signTx` via `session.createTransaction`, `signBytes` via
  `session.signRaw`) now reject with it when the failure is the statement-store
  `NoAllowanceError` (matched directly or anywhere on the `cause` chain) instead
  of a generic `Error` — so consumers can `catch (e) { if (e instanceof
AllowanceExpiredError) … }` and prompt a re-pair, rather than string-matching
  console output.

  Deliberately **thrown**, not returned as a `Result` `err`: it surfaces at
  PAPI's `PolkadotSigner.signTx`/`signBytes` boundary, whose contract is a
  rejecting Promise — an intentional exception to the SDK-wide Result
  convention. Re-exported from `@parity/product-sdk-terminal` (which gains a
  `@parity/product-sdk-signer` workspace dependency).

  Note: the root-cause fix for the 240 s hang before this error is even
  reachable lives upstream in `@novasamatech/host-papp`
  (`awaitReplyOrAckFailure` drops rejected ACKs) and is tracked separately.

- bffc04a: **Degrade gracefully when resolving a product account while signed out (#253).**

  When `HostProvider` is configured with `productAccount` and `connect()` runs
  without an active user session, the signed-out (`NotConnected`) state was
  treated as a fault: logged at `error` level with an opaque `{ cause }` payload
  (which serialized to `{}`), and retried up to 3× by `connect()`. It now
  soft-degrades to an empty accounts list (read-only), mirroring the `dappName`
  branch — signed-out and unregistered-identifier (`DomainNotValid`) failures log
  at `debug`/`warn` and skip retries, while genuine transient faults still error
  and retry.

  All host-RPC error logs in `host.ts` now serialize a readable message
  (`{ error: <message> }`) instead of the opaque `{ cause }`, so structured log
  sinks show the actual reason. `HostRejectedError` gains a `nonTransient` flag
  carrying the classification.

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

- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
  - @parity/product-sdk-host@0.15.0
  - @parity/product-sdk-keys@0.3.17

## 0.11.1

### Patch Changes

- 8ab88ba: Preserve local host and port product identifiers when deriving the default host account.
- Updated dependencies [8ab88ba]
  - @parity/product-sdk-host@0.14.1
  - @parity/product-sdk-keys@0.3.16

## 0.11.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [c3fccfa]
- Updated dependencies [c3fccfa]
  - @parity/product-sdk-host@0.14.0
  - @parity/product-sdk-keys@0.3.15

## 0.10.0

### Minor Changes

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
- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
  - @parity/product-sdk-host@0.13.0
  - @parity/result@0.2.0
  - @parity/product-sdk-errors@0.2.0
  - @parity/product-sdk-keys@0.3.14

## 0.9.0

### Minor Changes

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

### Patch Changes

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

- Updated dependencies [f81fc2b]
- Updated dependencies [f81fc2b]
- Updated dependencies [f81fc2b]
  - @parity/product-sdk-host@0.12.0
  - @parity/product-sdk-keys@0.3.13

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
