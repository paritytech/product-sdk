---
"@parity/product-sdk": minor
"@parity/product-sdk-individuality": patch
"@parity/product-sdk-host": minor
"@parity/product-sdk-terminal": patch
---

Support chains that declare more than one transaction-extension pipeline version, such as People runtime 3004000 on previewnet and paseo-next-v2. `withAsPerson`, `withLiteAlias`, `withScoreParticipant` and `buildLiteAliasBindTx` now use the version whose pipeline declares their extension and fill the extensions PAPI does not know, instead of failing with "chain declares a transaction-extension pipeline version this package cannot encode". The host and terminal signers now default `txExtVersion` to the lowest pipeline version that declares every supplied extension, which stays `0` on a chain with one pipeline. The resolver is exported as `resolveTxExtVersion` and as the host-free `@parity/product-sdk-host/tx-ext-version` subpath.
