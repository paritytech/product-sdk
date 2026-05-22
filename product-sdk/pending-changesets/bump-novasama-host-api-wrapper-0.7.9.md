---
"@parity/product-sdk": patch
"@parity/product-sdk-host": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk-statement-store": patch
---

**Bump `@novasamatech/host-api-wrapper` and `@novasamatech/host-api` to `^0.7.9` (stable).**

`0.7.9` is the first stable release on the `0.7.9` line. The previous catalog pinned the `0.7.9-6` prerelease exactly (no caret); this bump relaxes both entries to `^0.7.9` so the auto-bumper (`product-sdk-deps-check.yml`) can pick up future patch releases automatically.

No source-level changes for consumers — `0.7.9` is the same API surface as the prereleases we were already shipping against.
