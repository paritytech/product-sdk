# @parity/product-sdk-renderer

## 0.6.0

### Minor Changes

- 133451f: `@parity/product-sdk-react-renderer` now covers the whole renderer vocabulary. The new `Image` and `Effect` components complete the eleven node types, and `opacity` and `blendingMode` complete the twelve modifiers every widget accepts.

  Serialization no longer emits fields the protocol does not declare on a node. `Spacer`, `TextField` and `Image` are sent without `children`, and `Effect` without `modifiers`; before this, a card of any size produced a run of `unknown-field` warnings that a host silently ignored.

  `createRenderer` takes a new `validate` option: a checker to run over every tree before it reaches `onRender`, reporting each issue to the console with its path. Pass `validateFace` from `@parity/product-sdk-renderer`. It is injected rather than imported so that a bundle which never asks for checking does not carry the checker, which an eager import could not be shaken out of. It never throws, because an exception inside the reconciler's commit would leave React half applied.

  `drawPocketCard` joins a Pocket card to a React tree. It takes the manager structurally, so neither package depends on the other, and it does the adapting between the two action shapes: the host reports a press as hex, the renderer wants bytes, and a press that carried nothing arrives as no payload rather than an empty array. The card is then a component with state, so a press is `onClick` and React streams the next face.

  `@parity/product-sdk-renderer` exports its vocabulary tables, `NODE_SCHEMA` and `MODIFIER_SCHEMA`, so a consumer can hold its own coverage against the protocol. The React renderer's own completeness test does exactly that.

## 0.5.0

### Minor Changes

- a1e1f72: **Pair with a truapi 0.24.0 host.** `@parity/truapi` moves from `^0.23.0` to `^0.24.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `ea1a1441ff0219b1` to `c130fa60ef495768`, so the schema a product speaks no longer matches a host still on 0.23.0. Every host surface has to move in the same window.

## 0.4.0

### Minor Changes

- df6b2c0: **Pair with a truapi 0.23.0 host.** `@parity/truapi` moves from `^0.20.0` to `^0.23.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `462dacb6e0d1f504` to `ea1a1441ff0219b1`, so the schema a product speaks no longer matches a host still on 0.20.0. Every host surface has to move in the same window.

  **Surface changes carried through `@parity/product-sdk-host`.** truapi 0.23 adds a `contacts` domain (a `getTruApi().contacts.pick` picker; modeled as not-supported by the testing fake, and product-account transactions now send an empty `contacts` list). It also dropped four type aliases the host re-exported, replaced by the primitives they always were, so no runtime change: `NotificationId` and `CoinPaymentPurseId` are `number`, payment `Balance` is `bigint`, and a statement `Topic` is a `` `0x${string}` `` hex. The `NotificationId` and `Topic` names stay exported from this package as local aliases, so importers are unaffected.

## 0.3.0

### Minor Changes

- 206f791: **Pair with a truapi 0.20.0 host.** `@parity/truapi` moves from `^0.18.0` to `^0.20.0`. The codec version (3) and `TRUAPI_WIRE_SCHEMA_HASH` (`462dacb6e0d1f504`) are unchanged, so products and hosts on either version still talk to each other.

## 0.2.0

### Minor Changes

- a0fcb48: Add `@parity/product-sdk-renderer`: a typed builder for renderer trees and `validateFace`, which checks a
  face against the renderer protocol without a device.

  The builders make the encoding traps unreachable — `padding(20, 24)` cannot omit an edge, and enum names
  and node shapes are checked by the compiler. `validateFace` separates what the protocol forbids from what
  it allows and you probably did not mean, and treats one host's depth, size and byte bounds as advice
  unless you name that host.

  Reachable from the umbrella as `@parity/product-sdk/renderer`.
