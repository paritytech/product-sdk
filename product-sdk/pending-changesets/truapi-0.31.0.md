---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
---

**Pair with a truapi 0.31.0 host.** `@parity/truapi` moves from `^0.29.0` to `^0.31.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `22e6584ca33f86cd` to `cebcc89a5e45bbd3`, so the schema a product speaks no longer matches a host still on 0.29.0. Every host surface has to move in the same window.

What changed in the truapi surface, and how the SDK absorbs it:

- **An image can be carried in the tree itself.** `ImageSource` gains `Inline`, whose value is the image's own bytes as `0x`-prefixed hex: PNG, JPEG or WebP, at most 64 KiB. `@parity/product-sdk-renderer` accepts the new source and checks it: `validateFace` reports `inline-image-not-hex` for a value that is not whole hex bytes and `inline-image-too-large` for one past the protocol's cap, next to the existing `unknown-image-source`. `@parity/product-sdk-react-renderer`'s `Image` takes `source={{ tag: "Inline", value: "0x..." }}` through the shared type with no change of its own.
- **Two more render contexts.** `RenderContext` gains `PocketCardBack`, the back of a card whose definition declares one, and `ChatRoomFooter`, a card a product docks under a room's messages. `getRendererManager().draw()` and `registerRenderContext` accept both tags; the Pocket and chat managers do not route them yet, so a product that draws one claims the context itself.
- **A room footer can be a card.** `ChatRoomFooter` is now a tagged union with `TextInput`, `Empty` and `Card`, and the client still takes the plain strings for the first two. `getChatManager()` does not set footers, so this reaches only products calling `chat.setRoomFooter` through `getTruApi()`.
- **`createTransaction` can report `ChainUnavailable`** when the chain stayed unreachable and nothing was signed. The SDK's signers forward the error's reason as before; the new tag is safe to retry on.
- **The funding provider domain grows** with quotes, deposits, payout and refund steps, and progress details. The SDK does not model `fundingProvider`; `createFakeHost()` still lists it as not modeled.
- **`expandedCard.setBackShown`** turns the card above a widget. Not modeled by the SDK; reachable through `getTruApi()`.
- `@parity/truapi-host` moves to `^0.31.0` alongside, which also ships the `./node` entry the terminal's move onto the truapi core depends on.
