---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
"@parity/product-sdk-terminal": minor
---

**Pair with a truapi 0.32.0 host.** `@parity/truapi` moves from `^0.31.0` to `^0.32.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `cebcc89a5e45bbd3` to `7c6a3a324db0decd`, so the schema a product speaks no longer matches a host still on 0.31.0. Every host surface has to move in the same window.

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
