---
"@parity/product-sdk-address": patch
"@parity/product-sdk-keys": patch
---

Drop the hand-rolled `hexToBytes`/`bytesToHex` copies in `address/h160.ts` and `keys/key-manager.ts` in favour of the `@noble/hashes` versions already pulled in elsewhere. No public surface changes (the local functions were private). noble's `hexToBytes` is stricter than the hand-rolled one (it rejects non-hex input instead of silently producing zero bytes), which is safe here because both call sites pass un-prefixed, even-length hex; verified against the existing address and keys test suites, including the RFC-0022 product-account vectors.
