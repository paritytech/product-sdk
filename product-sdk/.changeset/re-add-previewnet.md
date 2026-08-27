---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Re-add `previewnet` as a first-class environment.**

Previewnet was dropped when its identity endpoints weren't secured for public use and its runtime matched paseo. Both have changed: the endpoints are secured, and previewnet now runs a Paseo runtime kept a step ahead of paseo-next-v2 (asset-hub `2000039` vs `2000036`, individuality `1000036` vs `1000032`), so products can build against upcoming runtime changes weeks early.

- `@parity/product-sdk-descriptors` re-adds the `./previewnet-asset-hub`, `./previewnet-bulletin`, and `./previewnet-individuality` subpath exports, generated fresh against the live endpoints with real (non-zero) `codeHash` values so previewnet is covered by descriptor-drift detection like every other chain.
- `@parity/product-sdk-chain-client` re-adds `"previewnet"` to the `Environment` union; `getChainAPI("previewnet")` resolves again, routing to the `previewnet.substrate.dev` endpoints for asset-hub, bulletin, and people (individuality).
- `@parity/product-sdk-cloud-storage` re-adds the `previewnet` entry to `CloudStorageNetworks`.
- `@parity/product-sdk-host` re-adds `BULLETIN_RPCS.previewnet`.

Consumers on paseo or a production environment are unaffected; this is purely additive.
