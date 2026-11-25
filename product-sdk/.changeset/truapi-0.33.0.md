---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
"@parity/product-sdk-terminal": minor
---

**Pair with a truapi 0.33.0 host.** `@parity/truapi` moves from `^0.32.0` to `^0.33.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `7c6a3a324db0decd` to `4bc9188c850e3b8c`, so the schema a product speaks no longer matches a host still on 0.32.0. Every host surface has to move in the same window.

**`ChatManager.registerRoom` follows truapi 0.33's room ids.** The request takes `roomIdSource` (the product's own name for the room) and `config` (which parts of the room the product serves) in place of `roomId`. It resolves to `{ status, roomId }`, where `roomId` is the id the host derived for the room. Name the room with that `roomId` in every later call, such as `sendMessage`. A host before truapi 0.33 cannot create a room for a product on this release.
