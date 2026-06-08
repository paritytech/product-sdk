---
"@parity/product-sdk-statement-store": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

Migrate `@parity/product-sdk-host`'s low-level host-API surface — plus the statement store and preimage — from the third-party `@novasamatech` packages to the in-house `@parity/truapi` client, and drop `@novasamatech/sdk-statement` from `@parity/product-sdk-statement-store`.

A new sandbox-bootstrap module detects the host environment (iframe / webview / injected message port), builds the `@parity/truapi` transport, creates the client, and runs the `system.handshake` — replacing the wrapper's auto-detected `hostApi` singleton. `@parity/truapi` is now a hard runtime dependency of `host` (alongside `neverthrow`); the `@novasamatech/*` packages remain **optional peers** for the surfaces still routed through the wrapper (marked with `TODO`s in the source). Behavior of those surfaces is unchanged.

**Migrated to `@parity/truapi`:** `getTruApi`, `requestResourceAllocation`, `requestPermission`, `requestDevicePermission`, `deriveEntropy`, `getHostLocalStorage` / `createHostLocalStorage` (adapted onto `localStorage.read/write/clear`), `isInsideContainer` / `isInsideContainerSync`, `getStatementStore` + `createProofAuthorized` (`statementStore.*`), `getPreimageManager` / `createHostPreimageManager` (`preimage.*`), `getThemeProvider` (`theme.*`), `getChatManager` (`chat.*`), and `getPaymentManager` (`payment.*`).

**Still on `@novasamatech/host-api-wrapper`:** `getHostProvider` (the PAPI `JsonRpcProvider`) and `getAccountsProvider`.

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
