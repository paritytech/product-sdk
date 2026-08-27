---
"@parity/product-sdk-host": patch
"@parity/product-sdk-terminal": patch
---

**Use the signed V4 envelope when a runtime also advertises V5.**

Product-account signers now prefer an advertised Extrinsic V4 format because metadata alone cannot prove that the connected host implements a runtime's V5 authorization pipeline. V5-only runtimes continue to use V5, preserving explicit host capability errors and future authorization support.
