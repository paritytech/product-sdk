---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
---

**Pair with a truapi 0.29.0 host.** `@parity/truapi` moves from `^0.28.0` to `^0.29.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `1ddad8b65de84b98` to `22e6584ca33f86cd`, so the schema a product speaks no longer matches a host still on 0.28.0. Every host surface has to move in the same window.
