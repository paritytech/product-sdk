---
"@parity/product-sdk-descriptors": patch
---

Regenerate PAPI descriptors against current live-chain runtime metadata for `devnet-asset-hub`, `devnet-individuality`, `kusama-asset-hub`, `paseo-asset-hub`, `paseo-bulletin`, `paseo-individuality`, and `polkadot-asset-hub` (issue #242). `devnet-bulletin` was already at the live `codeHash` and is unchanged. (`devnet-individuality` was reported unreachable when the issue was generated but its RPC was reachable at regeneration time and it had also drifted.)

No source-level API surface changes for consumers — this refreshes the bundled `.scale` metadata blobs and re-pins the `codeHash` in each chain's `.papi/polkadot-api.json` so PAPI's type bindings match the live runtime (genesis is unchanged for every chain). Stale bindings can otherwise manifest as `Incompatible runtime entry RuntimeCall(...)` errors or silent subscription mis-decodes.
