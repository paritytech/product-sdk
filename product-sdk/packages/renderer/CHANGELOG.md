# @parity/product-sdk-renderer

## 0.11.0

### Minor Changes

- 5dab257: **Pair with a truapi 0.29.0 host.** `@parity/truapi` moves from `^0.28.0` to `^0.29.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `1ddad8b65de84b98` to `22e6584ca33f86cd`, so the schema a product speaks no longer matches a host still on 0.28.0. Every host surface has to move in the same window.

  What changed in the truapi surface, and how `@parity/product-sdk-host` absorbs it:

  - **Product identifiers are branded.** The wire now types `dotNsIdentifier`, `ProductProofContext.productId`, `listRingVrfKeys`'s `owner`, `getProductContext`'s `productId` and an `NftPurseRead` permission's `Product` owner as `ProductId`, a branded string. The SDK keeps plain strings on its own surface: `ProductAccount`, `ProductAccountLookup` and `ProductProofContext` are now SDK-owned types whose `dotNsIdentifier` / `productId` stay `string`, and the host adapter brands them with `asProductId` at the wire boundary. Nothing changes for callers of `getProductAccount`, `signVrf`, `listRingVrfKeys`, `getProductAccountAlias` or `createRingVRFProof`. The one place the brand reaches product code is a `RemotePermission` built by hand for `requestPermission` with an `NftPurseRead` `Product` owner: brand that value with the newly re-exported `asProductId`; the `ProductId` type is re-exported next to it.
  - **A `fundingProvider` domain joins the client**, the worker side of the funding modality: host-initiated `onAssign` / `onCancel` / `onSettleCancel` handlers plus `report` and `presentFrame`. The SDK does not model it yet. `createFakeHost()` lists it as not modeled, so touching it in a test throws a descriptive error like the other unmodeled domains.
  - **`funding.request` answers with the session's `intent`** (`HostFundingResponse`) instead of nothing, and the request no longer carries a caller-chosen `id`. The SDK does not wrap `funding`, so this reaches only products calling it through `getTruApi()`.
  - **Payments move to `V2`.** `payment.request` and `payment.topUp` gain an optional `funding` intent and the `AlreadyExists` / `FundingNotServed` errors; the `V1` shapes live on as `V01HostPayment*`. `getPaymentManager()` is unchanged: it never sets `funding`, and the generated client picks the version.

## 0.10.0

### Minor Changes

- a708cb6: **Pair with a truapi 0.28.0 host.** `@parity/truapi` moves from `^0.27.0` to `^0.28.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `72bf858138ead26e` to `1ddad8b65de84b98`, so the schema a product speaks no longer matches a host still on 0.27.0. Every host surface has to move in the same window.

## 0.9.0

### Minor Changes

- a413d28: **Pair with a truapi 0.27.0 host.** `@parity/truapi` moves from `^0.26.0` to `^0.27.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `5f68beddf80f7b9a` to `72bf858138ead26e`, so the schema a product speaks no longer matches a host still on 0.26.0. Every host surface has to move in the same window.

  **Surface changes carried through `@parity/product-sdk-host`.** truapi 0.27 adds an `nftPurse` domain, modeled as not-supported by the testing fake. The change is additive, so nothing the host package already exposed changes.

## 0.8.0

### Minor Changes

- e9bfd25: **Pair with a truapi 0.26.0 host.** `@parity/truapi` moves from `^0.25.0` to `^0.26.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `3c45e49b26c1ab97` to `5f68beddf80f7b9a`, so the schema a product speaks no longer matches a host still on 0.25.0. Every host surface has to move in the same window.

  **Surface changes carried through `@parity/product-sdk-host`.** truapi 0.26 makes the caller own the id for a payment and a top-up, so a reload can keep watching an in-flight session and a retry is idempotent. `PaymentManager.requestPayment` and `topUp` now take an optional `id` (a random 32-byte hex by default) and both return `{ id }`; `subscribePaymentStatus`'s first argument is that same `id`. truapi also adds a `funding` domain (modeled as not-supported by the testing fake) and a `BalanceAccess` remote permission, which passes through `requestPermission` unchanged.

## 0.7.0

### Minor Changes

- dde3b0d: **Pair with a truapi 0.25.0 host.** `@parity/truapi` moves from `^0.24.0` to `^0.25.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `c130fa60ef495768` to `3c45e49b26c1ab97`, so the schema a product speaks no longer matches a host still on 0.24.0. Every host surface has to move in the same window.

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
