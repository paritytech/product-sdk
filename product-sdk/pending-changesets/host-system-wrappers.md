---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Add typed wrappers for the host's navigation, feature-probe, chain-spec, and transaction-broadcast TruAPI calls.**

These raw `hostApi.*` methods previously required `getTruApi()` plus a manual `enumValue("v1", ...)` wrap and neverthrow `ResultAsync` unwrap. They now have thin, fully-typed wrappers in `@parity/product-sdk-host` (re-exported from `@parity/product-sdk/host`), matching the throw-on-error / return-null conventions of the existing `requestPermission`, `deriveEntropy`, and `getThemeProvider` helpers.

### New public API

- `navigateTo(url: string): Promise<void>` — deep-link / external navigation. Throws on `NavigateToErr::PermissionDenied` / `::Unknown`.
- `featureSupported(feature: Feature): Promise<boolean>` and `isChainSupported(genesisHash: HexString): Promise<boolean>` — probe host feature/chain support. `Feature` is `{ tag: "Chain"; value: HexString }`.
- `getChainSpec(genesisHash: HexString): Promise<ChainSpec | null>` — fetches genesis hash, chain name, and properties in one concurrent call. Returns `null` outside a container. `ChainSpec` carries `{ genesisHash, name, properties: ChainProperties | null, propertiesRaw: string }`; `properties` is the host's properties JSON parsed into `{ ss58Format?, tokenDecimals?, tokenSymbol?, [k]: unknown }`, with `propertiesRaw` preserving the original string (and `properties === null` when the JSON can't be parsed).
- `broadcastTransaction(genesisHash: HexString, transaction: HexString): Promise<string | null>` — broadcast a signed tx; resolves to the operation id (or `null`).
- `stopTransaction(genesisHash: HexString, operationId: string): Promise<void>` — stop an in-flight broadcast.

All wrappers throw `"<fn>: TruAPI unavailable"` when running outside a host container, except `getChainSpec`, which returns `null` to match the sibling `get*` getters.
