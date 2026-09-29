---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk-terminal": minor
---

Host and terminal signer factories accept an optional `txExtVersion`, defaulting to `0`. It names the transaction extension version used to encode the supplied extensions; the host or paired wallet chooses V4 or V5 from it and the runtime metadata. Setting another version forwards it unchanged without re-encoding the extension bytes.
