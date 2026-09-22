---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

Add `getPocketManager()`, for drawing the product's Pocket cards, reading its card list, hearing about
presses, and giving a card up.

One `renderer.onRender` registration serves every card, so two cards do not fight over the single slot and
neither interrupts the other. A handler that throws or rejects costs one render rather than every card the
product has. A cleanup that resolves after the card has left runs at once.
