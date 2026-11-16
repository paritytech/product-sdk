---
"@parity/product-sdk-renderer": patch
"@parity/product-sdk-react-renderer": patch
---

**A face can ask for a slide instead of a tap.** The renderer vocabulary gains `SlideToConfirm`, a control the person slides to confirm, for a step that should be deliberate. The host owns the drag and reports one action when the slide completes, with an empty payload, as a `Button` press does.

- `@parity/product-sdk-renderer`: `NODE_SCHEMA` declares `SlideToConfirm` with `text` (required), `secondaryText`, `confirmedText`, `variant` (`Thumb` or `Reveal`), `accent` (a colour token), `enabled`, `loading`, `confirmed` and `confirmAction`, and no children. `validateFace` refuses an unknown variant or accent, and warns with `slide-without-action` when a control that can still be slid names no `confirmAction`. `SlideToConfirmProps` and `SlideToConfirmVariant` are re-exported.
- `@parity/product-sdk-react-renderer`: a `SlideToConfirm` component next to `Button`, whose `onConfirm` runs once per completed slide.

Only a host whose truapi carries the node can draw it, and an older host cannot decode a tree that holds one. A chat worker that may meet an older app should send a `Button` with the same action there.
