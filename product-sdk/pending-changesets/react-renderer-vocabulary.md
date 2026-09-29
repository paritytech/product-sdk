---
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
"@parity/product-sdk": minor
---

`@parity/product-sdk-react-renderer` now covers the whole renderer vocabulary. The new `Image` and `Effect` components complete the eleven node types, and `opacity` and `blendingMode` complete the twelve modifiers every widget accepts.

Serialization no longer emits fields the protocol does not declare on a node. `Spacer`, `TextField` and `Image` are sent without `children`, and `Effect` without `modifiers`; before this, a card of any size produced a run of `unknown-field` warnings that a host silently ignored.

`createRenderer` takes a new `validate` option: a checker to run over every tree before it reaches `onRender`, reporting each issue to the console with its path. Pass `validateFace` from `@parity/product-sdk-renderer`. It is injected rather than imported so that a bundle which never asks for checking does not carry the checker, which an eager import could not be shaken out of. It never throws, because an exception inside the reconciler's commit would leave React half applied.

`drawPocketCard` joins a Pocket card to a React tree. It takes the manager structurally, so neither package depends on the other, and it does the adapting between the two action shapes: the host reports a press as hex, the renderer wants bytes, and a press that carried nothing arrives as no payload rather than an empty array. The card is then a component with state, so a press is `onClick` and React streams the next face.

`@parity/product-sdk-renderer` exports its vocabulary tables, `NODE_SCHEMA` and `MODIFIER_SCHEMA`, so a consumer can hold its own coverage against the protocol. The React renderer's own completeness test does exactly that.
