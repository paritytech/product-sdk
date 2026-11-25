# @parity/product-sdk-react-renderer

## 0.11.0

### Minor Changes

- e686f3f: **Pair with a truapi 0.33.0 host.** `@parity/truapi` moves from `^0.32.0` to `^0.33.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `7c6a3a324db0decd` to `4bc9188c850e3b8c`, so the schema a product speaks no longer matches a host still on 0.32.0. Every host surface has to move in the same window.

  **`ChatManager.registerRoom` follows truapi 0.33's room ids.** The request takes `roomIdSource` (the product's own name for the room) and `config` (which parts of the room the product serves) in place of `roomId`. It resolves to `{ status, roomId }`, where `roomId` is the id the host derived for the room. Name the room with that `roomId` in every later call, such as `sendMessage`. A host before truapi 0.33 cannot create a room for a product on this release.

### Patch Changes

- Updated dependencies [e686f3f]
  - @parity/product-sdk-renderer@0.14.0

## 0.10.0

### Minor Changes

- 73fbe82: **Pair with a truapi 0.32.0 host.** `@parity/truapi` moves from `^0.31.0` to `^0.32.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `cebcc89a5e45bbd3` to `7c6a3a324db0decd`, so the schema a product speaks no longer matches a host still on 0.31.0. Every host surface has to move in the same window.

  What changed in the truapi surface, and how the SDK absorbs it:

  - **`Materials` replaces `Effect`. Breaking for faces.** The `Effect` node is gone, along with `EffectProps` and its one effect, `Rainbow`. A host on 0.32.0 refuses a tree that still carries it. In its place, a `Materials` node runs shader layers over its children. Each layer names a material published on Bulletin by its 32-byte BLAKE2b-256 hash and passes one argument per parameter. A host that cannot draw the layers, or a material that fails to load, draws the children plain, so the children are the fallback look.
    - `@parity/product-sdk-react-renderer` replaces the `Effect` component with `<Materials layers={...}>`.
    - `@parity/product-sdk-renderer` validates the node:
      - **Errors:** `validateFace` reports `missing-field` for a layer without `args` (an empty list is fine), `material-not-id` for a material that is not `0x` and 64 hex digits, `unknown-parameter` and `unknown-image-ref` for tags outside the protocol, `parameter-wrong-length` for a vector of the wrong arity, and `parameter-not-bits` for a number that is not a 32-bit pattern.
      - **Warning:** it reports `materials-without-layers` for an empty stack and `parameter-not-finite` for an Infinity or NaN argument, both of which a host draws plain.
    - **Writing numbers.** The protocol carries a material's numbers as IEEE 754 single-precision bit patterns, so the new `floatBits(0.5)` helper writes them; a bare `0.5` is refused.
    - **New type re-exports:** the renderer also re-exports `MaterialsProps`, `MaterialInstance`, `Parameter` and `ImageRef`, and no longer re-exports `Effect`.
    - **Migration:** replace `<Effect effect="Rainbow">…</Effect>` with `<Materials layers={[...]}>…</Materials>`, or drop the wrapper.
  - **The terminal clears a product's storage on request.** truapi 0.32.0 calls `productStorage.clearProduct(productId)` when the core clears a product's state, and the callback is required.
    - **New layout:** the terminal now keeps product values in one directory per product under `<storageDir>/product/`, and `clearProduct` empties that directory and tells any open `localStorage` subscription the value is gone.
    - **Older values:** values an older terminal wrote flat in `product/` are still read, and each moves into its product's directory the next time its key is written. A flat file's name does not say which product owns it, so `clearProduct` leaves those files in place and marks the cleared product so it never reads them again. Another product's values are untouched.
  - **`renderer.failureSubscribe`** reports the `Materials` nodes a host drew plain, and why (`MaterialFailure`). Not modeled by the SDK; reachable through `getTruApi()`.
  - **`system.featureSupported` takes a `Materials` question** (format version, features). A product asks before sending materials, and a host built before 0.32.0 answers with an error, which reads as no. The SDK's own `featureSupported` use is chain-only and unchanged.
  - **`contacts.usernames`** answers the dotNS usernames of the user's unblocked chat contacts, for the game product only; every other product gets `Unsupported`. Not modeled by the SDK.
  - **`nftPurse.listCheques`** lists the NFT cheques a product created. Not modeled by the SDK yet; reachable through `getTruApi()`.
  - **Three envelope codecs are renamed** after the payload they carry: `VersionedHostCreateTransactionRequest` is `VersionedProductAccountTxPayload`, `VersionedHostCreateTransactionWithLegacyAccountRequest` is `VersionedLegacyAccountTxPayload`, and `VersionedRemotePreimageSubmitError` is `VersionedPreimageSubmitError`. The bytes are unchanged and the SDK names none of them.
  - **Inside a native host, a product encodes its own frames** over the `window.__HOST_API_TRANSPORT__` channel the host's container injects, so it speaks the protocol version it was built against. `@parity/truapi` handles the transport.
    - **One change in reset handling:** when the product's own SDK cannot decode a frame, it resets the work in flight but the host's connection, and so its status, stays `connected`. Before, a reset always came with a lost and regained link.
    - **Fix in `@parity/product-sdk-host`:** the streams it opens again after a reset (chat and Pocket card actions, NFT purse watches) waited for that status change, so they stopped for good. They now open again after a short wait when the status stays `connected`: 250 ms at first, growing to 30 s while each reopened stream is reset again. An item, a real reconnect, or a minute without a reset starts the waits over.
  - `@parity/truapi-host` moves to `^0.32.0` alongside.

### Patch Changes

- Updated dependencies [73fbe82]
  - @parity/product-sdk-renderer@0.13.0

## 0.9.0

### Minor Changes

- 705abbd: **Pair with a truapi 0.31.0 host.** `@parity/truapi` moves from `^0.29.0` to `^0.31.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `22e6584ca33f86cd` to `cebcc89a5e45bbd3`, so the schema a product speaks no longer matches a host still on 0.29.0. Every host surface has to move in the same window.

  What changed in the truapi surface, and how the SDK absorbs it:

  - **An image can be carried in the tree itself.** `ImageSource` gains `Inline`, whose value is the image's own bytes as `0x`-prefixed hex: PNG, JPEG or WebP, at most 64 KiB. `@parity/product-sdk-renderer` accepts the new source and checks it: `validateFace` reports `inline-image-not-hex` for a value that is not whole hex bytes and `inline-image-too-large` for one past the protocol's cap, next to the existing `unknown-image-source`. `@parity/product-sdk-react-renderer`'s `Image` takes `source={{ tag: "Inline", value: "0x..." }}` through the shared type with no change of its own.
  - **Two more render contexts.** `RenderContext` gains `PocketCardBack`, the back of a card whose definition declares one, and `ChatRoomFooter`, a card a product docks under a room's messages. `getRendererManager().draw()` and `registerRenderContext` accept both tags; the Pocket and chat managers do not route them yet, so a product that draws one claims the context itself.
  - **A room footer can be a card.** `ChatRoomFooter` is now a tagged union with `TextInput`, `Empty` and `Card`, and the client still takes the plain strings for the first two. `getChatManager()` does not set footers, so this reaches only products calling `chat.setRoomFooter` through `getTruApi()`.
  - **`createTransaction` can report `ChainUnavailable`** when the chain stayed unreachable and nothing was signed. The SDK's signers forward the error unchanged, as they do every creation error; the protocol says a product may retry it with a bound on the attempts, and the SDK does not retry it for you.
  - **The funding provider domain grows** with quotes, deposits, payout and refund steps, and progress details. The SDK does not model `fundingProvider`; `createFakeHost()` still lists it as not modeled.
  - **`expandedCard.setBackShown`** turns the card above a widget. Not modeled by the SDK; reachable through `getTruApi()`.
  - `@parity/truapi-host` moves to `^0.31.0` alongside, which also ships the `./node` entry the terminal's move onto the truapi core depends on.

### Patch Changes

- Updated dependencies [705abbd]
  - @parity/product-sdk-renderer@0.12.0

## 0.8.0

### Minor Changes

- 5dab257: **Pair with a truapi 0.29.0 host.** `@parity/truapi` moves from `^0.28.0` to `^0.29.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `1ddad8b65de84b98` to `22e6584ca33f86cd`, so the schema a product speaks no longer matches a host still on 0.28.0. Every host surface has to move in the same window.

  What changed in the truapi surface, and how `@parity/product-sdk-host` absorbs it:

  - **Product identifiers are branded.** The wire now types `dotNsIdentifier`, `ProductProofContext.productId`, `listRingVrfKeys`'s `owner`, `getProductContext`'s `productId` and an `NftPurseRead` permission's `Product` owner as `ProductId`, a branded string. The SDK keeps plain strings on its own surface: `ProductAccount`, `ProductAccountLookup` and `ProductProofContext` are now SDK-owned types whose `dotNsIdentifier` / `productId` stay `string`, and the host adapter brands them with `asProductId` at the wire boundary. Nothing changes for callers of `getProductAccount`, `signVrf`, `listRingVrfKeys`, `getProductAccountAlias` or `createRingVRFProof`. The one place the brand reaches product code is a `RemotePermission` built by hand for `requestPermission` with an `NftPurseRead` `Product` owner: brand that value with the newly re-exported `asProductId`; the `ProductId` type is re-exported next to it.
  - **A `fundingProvider` domain joins the client**, the worker side of the funding modality: host-initiated `onAssign` / `onCancel` / `onSettleCancel` handlers plus `report` and `presentFrame`. The SDK does not model it yet. `createFakeHost()` lists it as not modeled, so touching it in a test throws a descriptive error like the other unmodeled domains.
  - **`funding.request` answers with the session's `intent`** (`HostFundingResponse`) instead of nothing, and the request no longer carries a caller-chosen `id`. The SDK does not wrap `funding`, so this reaches only products calling it through `getTruApi()`.
  - **Payments move to `V2`.** `payment.request` and `payment.topUp` gain an optional `funding` intent and the `AlreadyExists` / `FundingNotServed` errors; the `V1` shapes live on as `V01HostPayment*`. `getPaymentManager()` is unchanged: it never sets `funding`, and the generated client picks the version.

### Patch Changes

- Updated dependencies [5dab257]
  - @parity/product-sdk-renderer@0.11.0

## 0.7.0

### Minor Changes

- a708cb6: **Pair with a truapi 0.28.0 host.** `@parity/truapi` moves from `^0.27.0` to `^0.28.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `72bf858138ead26e` to `1ddad8b65de84b98`, so the schema a product speaks no longer matches a host still on 0.27.0. Every host surface has to move in the same window.

### Patch Changes

- Updated dependencies [a708cb6]
  - @parity/product-sdk-renderer@0.10.0

## 0.6.0

### Minor Changes

- a413d28: **Pair with a truapi 0.27.0 host.** `@parity/truapi` moves from `^0.26.0` to `^0.27.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `5f68beddf80f7b9a` to `72bf858138ead26e`, so the schema a product speaks no longer matches a host still on 0.26.0. Every host surface has to move in the same window.

  **Surface changes carried through `@parity/product-sdk-host`.** truapi 0.27 adds an `nftPurse` domain, modeled as not-supported by the testing fake. The change is additive, so nothing the host package already exposed changes.

### Patch Changes

- Updated dependencies [a413d28]
  - @parity/product-sdk-renderer@0.9.0

## 0.5.0

### Minor Changes

- e9bfd25: **Pair with a truapi 0.26.0 host.** `@parity/truapi` moves from `^0.25.0` to `^0.26.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `3c45e49b26c1ab97` to `5f68beddf80f7b9a`, so the schema a product speaks no longer matches a host still on 0.25.0. Every host surface has to move in the same window.

  **Surface changes carried through `@parity/product-sdk-host`.** truapi 0.26 makes the caller own the id for a payment and a top-up, so a reload can keep watching an in-flight session and a retry is idempotent. `PaymentManager.requestPayment` and `topUp` now take an optional `id` (a random 32-byte hex by default) and both return `{ id }`; `subscribePaymentStatus`'s first argument is that same `id`. truapi also adds a `funding` domain (modeled as not-supported by the testing fake) and a `BalanceAccess` remote permission, which passes through `requestPermission` unchanged.

### Patch Changes

- Updated dependencies [e9bfd25]
  - @parity/product-sdk-renderer@0.8.0

## 0.4.0

### Minor Changes

- dde3b0d: **Pair with a truapi 0.25.0 host.** `@parity/truapi` moves from `^0.24.0` to `^0.25.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `c130fa60ef495768` to `3c45e49b26c1ab97`, so the schema a product speaks no longer matches a host still on 0.24.0. Every host surface has to move in the same window.

### Patch Changes

- Updated dependencies [dde3b0d]
  - @parity/product-sdk-renderer@0.7.0

## 0.3.0

### Minor Changes

- 133451f: `@parity/product-sdk-react-renderer` now covers the whole renderer vocabulary. The new `Image` and `Effect` components complete the eleven node types, and `opacity` and `blendingMode` complete the twelve modifiers every widget accepts.

  Serialization no longer emits fields the protocol does not declare on a node. `Spacer`, `TextField` and `Image` are sent without `children`, and `Effect` without `modifiers`; before this, a card of any size produced a run of `unknown-field` warnings that a host silently ignored.

  `createRenderer` takes a new `validate` option: a checker to run over every tree before it reaches `onRender`, reporting each issue to the console with its path. Pass `validateFace` from `@parity/product-sdk-renderer`. It is injected rather than imported so that a bundle which never asks for checking does not carry the checker, which an eager import could not be shaken out of. It never throws, because an exception inside the reconciler's commit would leave React half applied.

  `drawPocketCard` joins a Pocket card to a React tree. It takes the manager structurally, so neither package depends on the other, and it does the adapting between the two action shapes: the host reports a press as hex, the renderer wants bytes, and a press that carried nothing arrives as no payload rather than an empty array. The card is then a component with state, so a press is `onClick` and React streams the next face.

  `@parity/product-sdk-renderer` exports its vocabulary tables, `NODE_SCHEMA` and `MODIFIER_SCHEMA`, so a consumer can hold its own coverage against the protocol. The React renderer's own completeness test does exactly that.

### Patch Changes

- Updated dependencies [133451f]
  - @parity/product-sdk-renderer@0.6.0

## 0.2.0

### Minor Changes

- a1e1f72: **Pair with a truapi 0.24.0 host.** `@parity/truapi` moves from `^0.23.0` to `^0.24.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `ea1a1441ff0219b1` to `c130fa60ef495768`, so the schema a product speaks no longer matches a host still on 0.23.0. Every host surface has to move in the same window.

### Patch Changes

- Updated dependencies [a1e1f72]
  - @parity/product-sdk-renderer@0.5.0

## 0.1.0

### Minor Changes

- df6b2c0: Add `@parity/product-sdk-react-renderer`: a React renderer for TrUAPI custom
  chat message widgets, ported from `@novasamatech/product-react-renderer` with
  all novasama dependencies replaced by `@parity/truapi` types.
- df6b2c0: **Pair with a truapi 0.23.0 host.** `@parity/truapi` moves from `^0.20.0` to `^0.23.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `462dacb6e0d1f504` to `ea1a1441ff0219b1`, so the schema a product speaks no longer matches a host still on 0.20.0. Every host surface has to move in the same window.

  **Surface changes carried through `@parity/product-sdk-host`.** truapi 0.23 adds a `contacts` domain (a `getTruApi().contacts.pick` picker; modeled as not-supported by the testing fake, and product-account transactions now send an empty `contacts` list). It also dropped four type aliases the host re-exported, replaced by the primitives they always were, so no runtime change: `NotificationId` and `CoinPaymentPurseId` are `number`, payment `Balance` is `bigint`, and a statement `Topic` is a `` `0x${string}` `` hex. The `NotificationId` and `Topic` names stay exported from this package as local aliases, so importers are unaffected.
