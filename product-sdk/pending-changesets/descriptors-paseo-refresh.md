---
"@parity/product-sdk-descriptors": patch
---

Regenerate `paseo-asset-hub` and `paseo-individuality` PAPI descriptors against the current live-chain runtime metadata. Caught by the daily descriptor-drift workflow: pinned `codeHash` had drifted from live. `kusama-asset-hub`, `polkadot-asset-hub`, and `paseo-bulletin` were already in sync and are unchanged.

No source-level API surface changes for consumers — this refreshes the bundled `.scale` metadata blobs and the pinned `codeHash` values in each chain's `.papi/polkadot-api.json` so PAPI's type bindings match the live runtime. Stale bindings can manifest as `Incompatible runtime entry RuntimeCall(...)` errors or silent subscription mis-decodes.
