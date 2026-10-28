---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
---

**Pair with a truapi 0.27.0 host.** `@parity/truapi` moves from `^0.26.0` to `^0.27.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `5f68beddf80f7b9a` to `72bf858138ead26e`, so the schema a product speaks no longer matches a host still on 0.26.0. Every host surface has to move in the same window.

**Surface changes carried through `@parity/product-sdk-host`.** truapi 0.27 adds an `nftPurse` domain, modeled as not-supported by the testing fake. The change is additive, so nothing the host package already exposed changes.
