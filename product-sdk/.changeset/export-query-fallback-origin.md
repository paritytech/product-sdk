---
"@parity/product-sdk-contracts": minor
"@parity/product-sdk": minor
---

**Export `QUERY_FALLBACK_ORIGIN` — pallet-revive's keyless account used as the read-only query origin.**

Other products (e.g. the playground CLI) pass an explicit `defaultOrigin` /
`registryOrigin` for read-only registry dry-runs and were re-deriving
pallet-revive's account (`PalletId(*b"py/reviv").into_account_truncating()` =
`5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV`) by mirroring the byte
derivation. The SDK already computes this internally as its read-only fallback
origin; it is now exported so consumers can import it instead of duplicating
the derivation:

```ts
import { QUERY_FALLBACK_ORIGIN } from "@parity/product-sdk-contracts";
```

No behaviour change — only a new export.
