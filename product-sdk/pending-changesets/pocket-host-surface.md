---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

Add `getPocketManager()`, for drawing the product's Pocket cards, reading its card list, hearing about
presses, and giving a card up.

A client has one `onRender` slot, and the renderer serves three kinds of body. So the slot is owned by a
small shared module that dispatches by context, and each surface claims only what it draws. Pocket claims
`PocketCard`, which leaves the chat and input contexts free. `getRendererManager()` claims one of those
for a product that draws it.

A handler that throws or rejects costs one render rather than every card the product has. A cleanup that
resolves after the card has left runs at once.
