---
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

**New package `@parity/product-sdk-nfts`: read Scarcity collections and item catalogues.**

**Every read is paged, and `limit` omitted does not mean "everything".** It defaults to
`DEFAULT_PAGE_LIMIT` (100) and caps at `MAX_PAGE_LIMIT` (1000), both exported. Nothing bounds how
many collections exist or how many items a collection holds. The only ceilings the pallet has are
index-space exhaustion, and the indices are `u32`. So a read whose default is "everything" is a
read that works until a deployment grows and then breaks a browser tab. All three take `limit` and
`fromId` and report `idCeiling` and `nextId`, so one pager works against any of them, and
`nextId === null` is the only end signal.

Three reads, all pure catalogue, with no identity, no purse and no second chain:

```ts
import {
    getClaimableCollections,
    getCollections,
    getCollectionItems,
} from "@parity/product-sdk-nfts";

const registry = await getClaimableCollections(chain, { limit: 100 });
// -> [{ id: 0, name: "One and only ", selection: { tag: "Random" }, itemCount: 1, owner }]

const browsing = await getCollections(chain, { limit: 100 });
// -> [{ id: 0, name: "One and only ", itemCount: 1, owner, selection: { tag: "Random" } },
//     { id: 1, name: "Unregistered",  itemCount: 0, owner, selection: null }]

const catalogue = await getCollectionItems(chain, 0, { limit: 100 });
// -> { tag: "Found", collection: { items: [{ index, supply, liveSupply, name, imageRef, rarity, attributes }] } }
```

**There is one kind of collection, and two sets of it.** `Scarcity.Collections` says a collection
exists. `NftClaims.CollectionMinters` is the map of a second pallet, whose entry means the owner opted in
through `set_collection_minter`, and which records how a claim picks an item. Its keys are a subset
of the first map's, so `getCollections` is the superset and `getClaimableCollections` is what the
registry leaves of it. How much that removes is per deployment: one carries six collections and
registers one, another registers most of what it carries, so neither read stands in for the other.

Reach for `getClaimableCollections` in a picker. A collection with no minter entry cannot be
claimed into. Reach for `getCollections` to browse or audit: `selection === null` is the only
"exists but accepts no claims" signal, with no separate boolean to drift out of sync with it.
All three reads are a constant four storage reads per page, whatever the counts, and their bytes
scale with the page rather than with the chain. Four reads is not four round trips: PAPI's
`getValues` opens one storage operation per key, so the operations of a page scale with `limit` while
its bytes do not. Prefer the registry read whenever only claimable
collections belong in the answer.

**`getCollections` pages by id window.**

```ts
const first = await getCollections(chain, { limit: 100 });
if (!first.ok) return;

let page = first.value;
const at = page.at;                   // pins the whole walk to one block
for (;;) {
    render(page.collections);         // 100, ascending by id
    if (page.nextId === null) break;  // the only end signal
    const next = await getCollections(chain, { limit: 100, fromId: page.nextId, at });
    if (!next.ok) throw next.error;   // a failed page is not the end of the walk
    page = next.value;
}
```

Four storage reads per page, the id ceiling plus three keyed reads over the window, whatever the
chain holds. Dumping the maps instead would cost roughly 15 MB at ten thousand collections, most of
it discarded, since the metadata dump carries every key when only `name` is wanted.

This works because the id space is knowable and dense: `create_collection` takes no id, so the
runtime allocates sequentially from `Scarcity.NextCollectionId`, and `delete_collection` documents
that identifiers are never reused. Every id is therefore readable by exact key.

**A page comes back full.** Deleted ids are holes, and the read walks past them rather than handing
back a short page. Ask for 100, get 100. That costs one extra record read per stretch of holes and
nothing else, since a hole never gets a name or registry lookup. A page is short only at the end of
the id space, or if a mostly-deleted range exhausts the scan budget, so **follow `nextId` rather
than counting**. `nextId === null` is the only end signal.

**Resuming by id is stable.** Ids are only ever appended, so paging forward cannot skip or
duplicate a collection even while the chain is written to, which offset-based paging over a mutable
set cannot promise.

**Every read now takes an `at` option**, a `FinalizedSnapshot` from the `at` of another result, joined
without a round trip. Separate calls otherwise pin separate blocks, which is right for unrelated
questions and wrong for one question asked in pages: a walk over its own snapshots is not a walk of
any single chain state. It is also how two reads are made to agree, so a catalogue read can address
the block the listing that offered the collection read at.

`CollectionsResult` gains `idCeiling` (the exclusive end of the id space, every collection ever
created, holes included) and `nextId`. `getClaimableCollections` takes the same `limit` / `fromId` / `nextId`, and paging it walks the same
id space. One difference worth knowing: the gaps its walk steps over are unregistered collections
rather than deleted ones, of which there can be many. At one collection in fifty registered, a page
of 10 returns 4 with `nextId` set. A short page is not the end, and on a registry that sparse the
rest of it arrives in a few more pages.

**`getClaimableCollections` no longer dumps chain-wide metadata.** It previously read names either
one prefix scan per registered collection, or, above sixteen of them, as one whole-map
`CollectionMetadata` dump carrying every key of every collection. Both are replaced by a
single exact-key read of exactly the rows wanted, so the read is now four reads and bytes
proportional to the registry at any size. `itemCount` from either listing read gives a collection's
size without reading its items.

The two disagree in one edge case, in opposite directions. A minter entry whose
`Scarcity.Collections` record is missing comes back from `getClaimableCollections` with `itemCount`
and `owner` `null`, and cannot appear in `getCollections`, which enumerates the records
themselves. `pallet_scarcity::OnCollectionDeleted` clears registrations, so it should not arise.

**`getCollectionItems` pages a catalogue the same way.** Nothing bounds the size of a
collection. The only item ceiling the pallet has is index-space exhaustion, `TooManyItems` reads "the
per-collection item index space is exhausted", and the index is a `u32`. So 10,000 items, roughly
70,000 metadata rows and about 14 MB in one response, is an afternoon of work for a collection owner,
which is why there is no read that answers with all of it.

```ts
const first = await getCollectionItems(chain, id, { limit: 100 });
// ...then follow `nextId`, passing `at` to pin the walk to one block.
```

Four reads per page whatever the collection holds: the collection record, its metadata defaults,
the item definitions in the window, and the metadata for those items. It works the same way the
collection listing does: `delete_item` documents that item indices are never reused, so a window of
indices is a stable page. A collection nobody created is not an error: it resolves to
`ok({ tag: "NotFound", … })`.

**A page carries the typed fields; `attributes` is opt-in.** `ItemMetadata` is keyed
`(collection, item, key)`, so keys the SDK can name, `name`, `image` and `rarity`, come back for a
whole window in one exact-key read. The keys of the open bag are unknowable in advance, so filling it
means a prefix scan of the item metadata of the whole collection. That is still one read, but bytes
proportional to the catalogue rather than to the page. So `attributes: true` is opt-in, and left off
the field is `null` rather than `{}`: an empty bag would read as "this item has no metadata", a
different claim from "this read did not fetch it". Collection defaults are inherited either way.
`CollectionItemsResult` reports `idCeiling` (every item index ever allocated) alongside `itemCount`
(the live definitions).

**Display metadata comes from storage.** `Scarcity.CollectionMetadata` and `ItemMetadata` are
merged here, with the item overriding the collection for the same key.

**Metadata is an open schema.** The pallet stores untyped `Vec<u8>` keys to `Vec<u8>` values and nothing
declares the keys. `name`, `image` and `rarity` are lifted into typed fields; every key is also
passed through in `attributes`. Values decode as UTF-8 when the bytes are readable text and as
`0x`-hex otherwise, and numbers are never parsed. On the live chain `energy` holds the two ASCII
characters `2` and `1`, so the chain stored text there rather than a binary number. `imageRef` is
an `ImageRef`, reporting the same bytes as `hex` and as `text` (`null` when they are not readable):
one deployment stores a 32-byte content digest there, another an ASCII CID, and nothing
declares which.

**An app that prunes its own descriptors must whitelist all six entries these reads touch**:
`Scarcity.NextCollectionId`, `Collections`, `ItemDefs`, `CollectionMetadata`, `ItemMetadata` and
`NftClaims.CollectionMinters`, including the ones its own code never reads. A missing entry fails
as the PAPI `Incompatible runtime entry Storage(...)`, which reads like descriptor drift. It now
arrives as the new `NftsChainEntryError`, naming the entry in its message, carrying it on `entry`
and the PAPI error as the `cause`.

`transferability` is **not** returned. It traces to `pallet_nfts`'
`CollectionSetting::TransferableItems` and has no source in `Scarcity`, not in `ItemDefs` and not in
any metadata key the live chain carries.

**Paseo only.** `devnet-asset-hub` carries neither pallet, which `@parity/product-sdk`'s
`src/nfts/contract.test.ts` pins as a negative control alongside the positive assertion that
the real Paseo descriptor satisfies the structural chain contract of the package.

Also exported from `@parity/product-sdk` as `@parity/product-sdk/nfts`.
