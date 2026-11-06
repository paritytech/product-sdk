---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
---

**A Pocket card can have a back.** A card whose manifest entry names a `back` can be turned over on the opened card, and the worker draws the back like the front:

- `drawPocketCard(pocket, cardId, element, { side: "back" })` draws the back. Its presses reach the back's tree alone, even when both sides name the same action.
- `PocketManager.drawCard` and `subscribeCardAction` take an optional `side`, `"front"` by default, so existing calls are unchanged. A product that draws no back leaves the back's render context unclaimed, and the host keeps showing the back it already has.
- `validateFace` accepts an `Image` that carries its own bytes (`{ tag: "Inline", value: "0x..." }`), and refuses one that is not hex, is more than 64 KiB, or is not a PNG, JPEG or WebP.

A Widget page turns the card with `expandedCard.setBackShown({ shown })` through `getTruApi()`.

Upgrade `@parity/product-sdk-host` and `@parity/product-sdk-react-renderer` together: an older Pocket manager ignores `side`, so `drawPocketCard` would draw the back in place of the front.
