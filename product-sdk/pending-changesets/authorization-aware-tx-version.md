---
"@parity/product-sdk-host": patch
"@parity/product-sdk-terminal": patch
---

**Select a transaction format the host can authorize.**

Product-account signers now use Extrinsic V5 on dual V4/V5 runtimes only when metadata's version-zero transaction-extension pipeline declares `VerifyMultiSignature`. When V5 has no host-signature slot, they use the runtime's advertised V4 signed envelope instead. V5-only runtimes continue to use V5, preserving explicit host capability errors and future authorization support.
