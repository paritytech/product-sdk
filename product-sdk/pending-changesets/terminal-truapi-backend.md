---
"@parity/product-sdk-terminal": minor
"@parity/product-sdk": minor
---

Add an experimental, opt-in truapi backend at `@parity/product-sdk-terminal/truapi`. It runs `@parity/truapi-host`'s WASM pairing host in Node instead of `@novasamatech/host-papp`: `createTruapiTerminal` pairs with the wallet over a `polkadotapp://pair` QR and persists the session under `~/.polkadot-apps/truapi/`, `createTruapiSigner` returns a `PolkadotSigner` (transactions via `signing.createTransaction`, bytes via `signRaw`), and `deriveEntropy`, `requestResourceAllocation`, `createStatementProof` and `submitStatement` cover the rest. Product account addresses match the default backend; sessions do not, so switching pairs once more. The default export is unchanged.
