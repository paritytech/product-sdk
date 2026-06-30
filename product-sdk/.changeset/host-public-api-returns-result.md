---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": patch
"@parity/product-sdk": minor
---

Move the throw→`Result` boundary into `@parity/product-sdk-host`: the flat public host operations now return a tagged `Result<T, HostError>` instead of throwing opaque `Error`s, so every consumer gets typed errors (not just the signer, which previously wrapped host's throws in its own `try/catch`).

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
