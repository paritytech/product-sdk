---
"@parity/product-sdk": minor
"@parity/product-sdk-utils": minor
---

`@parity/product-sdk-utils` gains the basics that time-dependent and protocol code shares: `bytesToUtf8`, `bytesEqual`, `u32ToLeBytes`, `u64ToLeBytes`, `i64ToLeBytes`, a `Clock` with `systemClock`, an `IdSource` with `uuidSource` (lowercase UUID v4, as the native chat apps make them), and a `./testing` subpath with `ManualClock`, whose `sleep` resolves only as a test advances it, and `settle`.
