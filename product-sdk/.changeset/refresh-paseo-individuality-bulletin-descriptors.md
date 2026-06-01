---
"@parity/product-sdk-descriptors": patch
---

Refresh `paseo-individuality` and `paseo-bulletin` descriptors against their live runtimes.

- `paseo-individuality`: chain was reset — genesis `0x053e1a…` → `0xc5af18…`, codeHash and metadata updated accordingly.
- `paseo-bulletin`: runtime upgrade — codeHash `0x4fe167…` → `0xbf2cd5…` and metadata updated (genesis unchanged).

Also updates the test-only genesis constant for `paseo_individuality` in `@parity/product-sdk-chain-client` to match.
