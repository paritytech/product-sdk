---
"@parity/product-sdk": minor
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk-host": minor
---

**Drop previewnet support.**

Previewnet is no longer used. Removed across the workspace:

- `@parity/product-sdk-descriptors` drops the `./previewnet-asset-hub`, `./previewnet-bulletin`, and `./previewnet-individuality` subpath exports.
- `@parity/product-sdk-chain-client` removes `"previewnet"` from the `Environment` union; `getChainAPI("previewnet")` no longer compiles or resolves.
- `@parity/product-sdk-cloud-storage` removes the `previewnet` entry from `CloudStorageNetworks`.
- `@parity/product-sdk-host` removes `BULLETIN_RPCS.previewnet`.

### Migration

Consumers using paseo (testnet) or one of the production environments are unaffected. Anyone importing a `previewnet-*` descriptor or referencing `Environment === "previewnet"` should drop the references — the underlying runtime is shared with paseo, so paseo is the direct replacement for testing.

Pre-1.0 breaking change per `RELEASES.md`; ships as `minor`.
