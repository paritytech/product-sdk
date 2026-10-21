---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
---

**Pair with a truapi 0.26.0 host.** `@parity/truapi` moves from `^0.25.0` to `^0.26.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `3c45e49b26c1ab97` to `5f68beddf80f7b9a`, so the schema a product speaks no longer matches a host still on 0.25.0. Every host surface has to move in the same window.
