---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Make `@novasamatech/*` runtime dependencies instead of optional peer dependencies.**

`@parity/product-sdk-host` now declares `@novasamatech/host-api` and
`@novasamatech/host-api-wrapper` as regular `dependencies` (via the existing `catalog:`
range) rather than optional `peerDependencies`. `host-api` was always required at runtime
— its `enumValue` is statically imported by the published bundle — so the optional-peer
declaration was incorrect; `host-api-wrapper` is loaded lazily by the host bridge and is
now pulled transitively too. Consumers can reach the host APIs purely through
`@parity/product-sdk-host` with no direct `@novasamatech/*` dependency of their own.
