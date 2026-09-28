---
"@parity/product-sdk-host": patch
"@parity/product-sdk-terminal": patch
---

`createTransaction` payloads name transaction extension version `0` as `txExtVersion`, which is the version PAPI encodes the signed extensions for. The host or paired wallet chooses V4 or V5 from it and the runtime metadata. A runtime offering only V5 previously received `5`, which hosts read as an undeclared extension version.
