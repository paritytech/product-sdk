---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
---

**Pair with a truapi 0.24.0 host.** `@parity/truapi` moves from `^0.23.0` to `^0.24.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `ea1a1441ff0219b1` to `c130fa60ef495768`, so the schema a product speaks no longer matches a host still on 0.23.0. Every host surface has to move in the same window.
