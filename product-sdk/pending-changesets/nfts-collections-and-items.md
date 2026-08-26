---
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

**New package `@parity/product-sdk-nfts`: read Scarcity collections and item catalogues.**

Two reads, both pure catalogue — no identity, no purse, no second chain:

```ts
import { getCollections, getCollectionItems } from "@parity/product-sdk-nfts";

const registry = await getCollections(chain);
// -> [{ id: 0, name: "One and only ", selection: { tag: "Random" }, itemCount: 1, owner }]

const catalogue = await getCollectionItems(chain, 0);
// -> { tag: "Found", collection: { items: [{ index, supply, liveSupply, name, imageRef, rarity, attributes }] } }
```

`getCollections` is driven by `NftClaims.CollectionMinters`, not by `Scarcity.Collections`: a
collection with no minter entry cannot be claimed into, so it does not belong in a collection
picker even if its catalogue exists. How much that removes is per deployment: one carries six
collections and registers one, another registers most of what it carries.

`getCollectionItems` is four reads whatever the item count, because `ItemDefs` and `ItemMetadata`
are both scanned by collection prefix rather than per item. A collection nobody created is not an
error: it resolves to `ok({ tag: "NotFound", … })`.

**Display metadata comes from storage, not from a runtime API.** The `ScarcityApi.metadata_batch`
this was originally specced against does not exist: live `next-asset-hub-paseo` (spec 2000036)
exposes 27 runtime APIs and neither `ScarcityApi` nor `NftClaimsApi` is among them. The pinned
descriptor code hash matches live, so this is not descriptor drift. `Scarcity.CollectionMetadata`
and `ItemMetadata` answer the same question, merged here with the item overriding the collection.

**Metadata is an open schema.** The pallet stores untyped `Vec<u8>` → `Vec<u8>` and nothing on chain
declares the keys. `name`, `image` and `rarity` are lifted into typed fields; every key is also
passed through in `attributes`. Values decode as UTF-8 when the bytes are readable text and as
`0x`-hex otherwise, and numbers are never parsed — one live item's `energy` is the two bytes `"21"`,
text and not a SCALE integer. `imageRef` is an `ImageRef`, reporting the same bytes as `hex` and as
`text` (`null` when they are not readable): one deployment stores a 32-byte content digest there,
another an ASCII CID, and nothing on chain declares which.

**An app that prunes its own descriptors must whitelist all five entries these reads touch** —
`Scarcity.Collections`, `ItemDefs`, `CollectionMetadata`, `ItemMetadata` and
`NftClaims.CollectionMinters` — including the ones its own code never reads. A missing entry fails
as PAPI's `Incompatible runtime entry Storage(...)`, which reads like descriptor drift; it now
arrives as the new `NftsChainEntryError`, naming the entry in its message, carrying it on `entry`
and PAPI's error as the `cause`.

`transferability` is **not** returned. It traces to `pallet_nfts`'
`CollectionSetting::TransferableItems` and has no source in `Scarcity` — not in `ItemDefs`, not in
any metadata key the live chain carries.

**Paseo only.** `devnet-asset-hub` carries neither pallet, which the umbrella's
`src/nfts/contract.test.ts` pins as a negative control alongside the positive assertion that
the real Paseo descriptor satisfies the package's structural chain contract.

Also exported from the umbrella as `@parity/product-sdk/nfts`.
