---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk": minor
---

**Breaking: remove the Summit Network (Web3 Summit) environment.**

The Summit event is over and its chains are being decommissioned. Removes
the `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
descriptors, `"summit"` from `Environment` / `CloudStorageEnvironment`
(`getChainAPI("summit")` and `CloudStorageClient.create({ environment:
"summit" })` no longer compile), the `CloudStorageNetworks.summit` preset,
and `BULLETIN_RPCS.summit`. `paseo` and `devnet` are unaffected.
