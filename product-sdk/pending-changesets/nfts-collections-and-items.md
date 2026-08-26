---
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

**New package `@parity/product-sdk-nfts`: read Scarcity collections and item catalogues.**

Three reads, all pure catalogue — no identity, no purse, no second chain:

```ts
import {
    getClaimableCollections,
    getCollections,
    getCollectionItems,
} from "@parity/product-sdk-nfts";

const registry = await getClaimableCollections(chain);
// -> [{ id: 0, name: "One and only ", selection: { tag: "Random" }, itemCount: 1, owner }]

const everything = await getCollections(chain);
// -> [{ id: 0, name: "One and only ", itemCount: 1, owner, selection: { tag: "Random" } },
//     { id: 1, name: "Unregistered",  itemCount: 0, owner, selection: null }]

const catalogue = await getCollectionItems(chain, 0);
// -> { tag: "Found", collection: { items: [{ index, supply, liveSupply, name, imageRef, rarity, attributes }] } }
```

**There is one kind of collection, and two sets of it.** `Scarcity.Collections` says a collection
exists; `NftClaims.CollectionMinters` is a second pallet's map whose entry means the owner opted in
through `set_collection_minter`, and which records how a claim picks an item. Its keys are a subset
of the first map's, so `getCollections` is the superset and `getClaimableCollections` is what the
registry leaves of it. How much that removes is per deployment: one carries six collections and
registers one, another registers most of what it carries, so neither read stands in for the other.

Reach for `getClaimableCollections` in a picker — a collection with no minter entry cannot be
claimed into, and `getCollections` pays a metadata read per collection to hand back ones a claim
cannot use. Reach for `getCollections` to browse or audit: `selection === null` is the only
"exists but accepts no claims" signal, with no separate boolean to drift out of sync with it.

The two disagree in one edge case, in opposite directions. A minter entry whose
`Scarcity.Collections` record is missing comes back from `getClaimableCollections` with `itemCount`
and `owner` `null`, and cannot appear in `getCollections`, which enumerates the records
themselves. `pallet_scarcity::OnCollectionDeleted` clears registrations, so it should not arise.

`getCollectionItems` is four reads whatever the item count, because `ItemDefs` and `ItemMetadata`
are both scanned by collection prefix rather than per item. A collection nobody created is not an
error: it resolves to `ok({ tag: "NotFound", … })`.

**Display metadata comes from storage.** `Scarcity.CollectionMetadata` and `ItemMetadata` are
merged here, with the item overriding the collection for the same key.

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

**Paseo only.** `devnet-asset-hub` carries neither pallet, which `@parity/product-sdk`'s
`src/nfts/contract.test.ts` pins as a negative control alongside the positive assertion that
the real Paseo descriptor satisfies the package's structural chain contract.

Also exported from `@parity/product-sdk` as `@parity/product-sdk/nfts`.
