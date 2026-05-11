---
"@parity/product-sdk-host": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk-statement-store": patch
---

**Bump `@novasamatech/product-sdk` and `@novasamatech/host-api` to `^0.7.8`.**

Picks up the latest novasama patch release. Catalog-pinned (`pnpm-workspace.yaml`), so the three consumer packages — `host`, `signer`, and `statement-store` — pick up the new version transitively. No source changes required in this SDK; the upstream patch is backwards-compatible at the API surface novasama exposes to us.
