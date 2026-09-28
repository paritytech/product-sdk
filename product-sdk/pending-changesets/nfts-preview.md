---
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

**`previewClaim(chain, { credit, collections })`: what one credit would mint in each collection.**

The answer comes from `NftClaimsApi.preview_mints`, the first runtime API this package reads. It
runs the real claim selector without spending anything, so for a `Random` collection the preview is
the item the claim will produce, and switching collection is the only way to change it. One call
takes the whole batch and answers positionally.

```ts
const preview = await previewClaim(chain, { credit, collections: [0, 3], at: registry.value.at });
// -> { at, previews: [{ collection: 0, outcome: { tag: "Mints", item, via, name, rarity, imageRef } },
//                     { collection: 3, outcome: { tag: "Fails", reason: "NoItems" } }] }
```

A collection the credit cannot mint into is a `Fails` outcome with the reason the runtime gave, not
an error, because the chain was asked and answered. The item that would mint is resolved through the
same exact-key metadata path a catalogue page uses, so `name`, `rarity` and `imageRef` agree with
`getCollectionItems` for the same item.

`NftsChain` gains `assetHub.apis.NftClaimsApi.preview_mints`. A client from `getChainAPI(...)`
satisfies it, and the fidelity guard in `@parity/product-sdk` now checks the runtime API signature
against the descriptor the way it checks the storage entries. A hand-rolled client has to provide it.
