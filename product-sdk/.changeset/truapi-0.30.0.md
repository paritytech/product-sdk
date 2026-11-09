---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
---

**Pair with a truapi 0.30.0 host.** `@parity/truapi` moves from `^0.29.0` to `^0.30.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `22e6584ca33f86cd` to `e81663cdcdb20a2f`, so the schema a product speaks no longer matches a host still on 0.29.0. Every host surface has to move in the same window.
