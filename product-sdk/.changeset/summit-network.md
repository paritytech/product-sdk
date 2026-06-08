---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk": minor
---

**Add the Summit Network (Web3 Summit) as a new environment.**

Adds `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
(the People chain) descriptors, and wires `summit` through the host
Bulletin RPC list, the cloud-storage network preset, and
`getChainAPI("summit")`. Purely additive — no existing environment,
descriptor, or endpoint changes.
