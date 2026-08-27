---
"@parity/product-sdk-signer": patch
---

**Preserve an already-qualified dotNS dapp name instead of double-suffixing it.**

`HostProvider`'s `dappName` is turned into a product identifier before `getProductAccount`. The rule keyed off `.dot`, so a name already carrying a different TLD — e.g. `host-playground.paseo` — got a second suffix and became the invalid `host-playground.paseo.dot`. It now qualifies only bare labels (no dot), matching `normalizeDotNsName`'s convention: any name that already contains a dot, plus localhost / loopback / localhost-subdomain forms, is passed through unchanged.
