---
name: product-sdk-nfts
description: >
  Use when reading Scarcity NFT collections or their item catalogues on Asset Hub, which
  collections a claim can mint into, every collection, and what one of them holds. Covers
  getClaimableCollections, getCollections and getCollectionItems, the one storage map that
  separates claimable from merely existing, the chain client they require and why a TypedApi is not
  enough, the descriptor entries they touch and what a pruned whitelist does, the open metadata
  schema and the two readings of ImageRef, why a missing collection is a success value rather than
  an error, getCredits across the People chain and Asset Hub with the four states a credit can be
  in, previewClaim and why it is the item a claim will produce, getVerifiedArtwork and why bytes
  are withheld unless they hash to the reference, and the purse-scoped reads that do not exist yet.
---

# Product SDK NFTs

`@parity/product-sdk-nfts` reads the Scarcity catalogue on Asset Hub. Three functions, all pure
reads, none needing an identity, a purse or a second chain. Also available as
`@parity/product-sdk/nfts`, the same code re-exported from `@parity/product-sdk`.

- `getClaimableCollections(chain, options?)` reads the collections registered to accept claims. Powers a
  picker. Every entry has a `selection`.
- `getCollections(chain, options?)` reads every collection, `selection` `null` where none is
  registered. For browsing or auditing.
- `getCollectionItems(chain, id, options?)` reads one page of the item catalogue of a collection. Applies
  **no** registry filter; a collection nobody created comes back as `{ tag: "NotFound" }`. Pass
  `attributes: true` for the open metadata bag.

## Everything Is Paged

**No read here is unbounded, and `limit` omitted does not mean "everything".** It defaults to
`DEFAULT_PAGE_LIMIT` (100) and caps at `MAX_PAGE_LIMIT` (1000), both exported. Nothing bounds how
many collections exist or how many items a collection holds. The only ceilings the pallet has are
index-space exhaustion and the indices are `u32`. So a read defaulting to "everything" is one
that works until a deployment grows and then breaks a browser tab.

One vocabulary for all three reads, so a single pager works against any of them:

| in | out |
|---|---|
| `limit`, `fromId` | `idCeiling`, `nextId` |

`nextId === null` is **the only end signal**. A page can be short of `limit` without being the
last, when a stretch of deleted or unregistered ids exhausts the scan budget. Follow the cursor
rather than counting results.

## One Kind Of Collection, Two Sets

There is **one** kind of collection. Two maps in two pallets describe it:

```
Scarcity.Collections         id -> { owner, item_count, … }   the collection exists
NftClaims.CollectionMinters  id -> { owner, selection }       the owner opted in via
                                                              set_collection_minter
```

`CollectionMinters` is not a second type of collection. It is an opt-in flag with config, and its
keys are a **subset** of `Scarcity.Collections`' keys. So `getCollections` is the superset and
`getClaimableCollections` is what the registry leaves of it. How much that removes is per
deployment: one carries six collections and registers one, another registers most of what it
carries, so neither read stands in for the other.

Which to reach for:

- **Picker, or spending a credit**: `getClaimableCollections`. A collection with no minter entry
  cannot be claimed into, so it does not belong in the list.
- **Browsing, gallery, audit**: `getCollections`. `selection === null` means "exists but accepts
  no claims", and it is the only signal. There is no separate `claimable` boolean to drift.
- **One known id**: `getCollectionItems`. No registry filter either.

All three are four storage reads a page, whatever the counts, so pick by which set you want.
Four reads is not four round trips: the PAPI `getValues` opens one storage operation per key, so
the operation count of a page scales with `limit` even though its bytes do not. What differs between the
three is which id space a page walks:

| Read | Walks |
|---|---|
| `getClaimableCollections` | collection ids, keeping the registered ones |
| `getCollections` | collection ids, keeping every live one |
| `getCollectionItems` | the item indices of one collection |

Prefer `getClaimableCollections` whenever only claimable collections belong in the answer.

### Paging `getCollections`

**`getCollections` is always paged**, at 100 collections per page by default. Dumping the maps
whole would cost around 15 MB at ten thousand collections, most of it discarded, because the
metadata dump carries every key when only `name` is wanted.

```typescript
const first = await getCollections(chain, { limit: 100 });
if (!first.ok) return;
render(first.value.collections);

// Pass the snapshot of the first page back in, so the whole walk addresses one block.
let fromId = first.value.nextId;
while (fromId !== null) {
    const page = await getCollections(chain, { fromId, limit: 100, at: first.value.at });
    if (!page.ok) throw page.error;          // a failed page is not the end of the walk
    render(page.value.collections);          // 100, ascending by id
    fromId = page.value.nextId;              // null when the id space is exhausted
}
```

**Pass `at` when you page.** Without it every page pins its own finalized block, so the walk is not
a walk of any single chain state. `itemCount` can move under you and a collection deleted
mid-walk vanishes. `at` takes a `FinalizedSnapshot` straight from another result and costs no round
trip. Every read in this package accepts it, so a catalogue read can also address the block the
listing came from. The node must still have the block pinned, so reuse a recent snapshot rather
than a stale one.

Four storage reads per page, the id ceiling plus three keyed reads over the window, whatever
the chain holds; the keys per page scale with `limit`, the bytes do not. It works because ids are allocated
sequentially by the runtime (`create_collection` takes no id) and **never reused**
(`delete_collection` says so), so `Scarcity.NextCollectionId` bounds the space and every id in a
window can be read by exact key.

Two consequences worth knowing:

- **A page comes back full.** Deleted ids are holes, and the read walks past them rather than
  handing back a short page. Ask for 100, get 100. It is short only at the end of the id space,
  or if a mostly-deleted range exhausts the scan budget, so **follow `nextId` rather than counting**:
  `nextId === null` is the only end signal. Stepping over holes costs one extra record read; a hole
  never gets a name or registry lookup.
- **Resuming by id is stable.** Ids are only ever appended, so paging forward cannot skip or
  duplicate a collection even while the chain is written to, a guarantee offset-based paging
  cannot give.

`getClaimableCollections` takes the same `limit`, `fromId`, `nextId` and `at`. One difference:

- **Its pages fill only while the chain is reasonably registered.** The gaps its walk steps over
  are unregistered collections, not deleted ones, and there can be many: at one collection in fifty
  registered, a page of 10 comes back with 4 and `nextId` set. A short page is not the end. Follow
  `nextId`, and on a registry that sparse the rest of it arrives in a few more pages.

`itemCount` from either listing read tells you the size of a collection without reading its items.

### Paging a catalogue

**Nothing caps the size of a collection.** The only item ceiling the pallet has is index-space
exhaustion. `TooManyItems` is documented as "the per-collection item index space is exhausted", and
the index is a `u32`. So there is no configured limit to rely on, and 10,000 items (≈70,000 metadata
rows, about 14 MB in one response) is an afternoon of work for a collection owner.

```typescript
const first = await getCollectionItems(chain, id, { limit: 100 });
if (!first.ok || first.value.tag !== "Found") return;
const at = first.value.at;                       // pin the whole walk to one block

let page = first.value;
for (;;) {
    render(page.collection.items);
    if (page.nextId === null) break;              // the only end signal
    const result = await getCollectionItems(chain, id, { limit: 100, fromId: page.nextId, at });
    if (!result.ok) throw result.error;           // a failed page is not the end of the walk
    if (result.value.tag !== "Found") break;      // deleted mid-walk: a real answer
    page = result.value;
}
```

**A page carries the typed fields; `attributes` is opt-in.** `ItemMetadata` is keyed
`(collection, item, key)`, so keys the SDK can name (`name`, `image`, `rarity`) come back for a whole
window in one exact-key read. The keys of the open bag are unknowable in advance, so filling it means a
prefix scan of the item metadata of **the whole collection**. That is still one read, but bytes proportional to
the catalogue rather than to the page. Pass `attributes: true` for a collection you know is small, or
when a caller genuinely needs app-specific keys. Left off, `attributes` is `null`, meaning "not fetched",
a different claim from an empty bag meaning "this item has no metadata".

Collection-level defaults are inherited either way, so an item resolves `name` / `image` / `rarity`
from its collection where it does not override them. `idCeiling` counts every item index ever
allocated (indices are never reused); `itemCount` counts the live ones.

The two disagree in one edge case, in opposite directions. A minter entry whose
`Scarcity.Collections` record is missing appears in `getClaimableCollections` with `itemCount` and
`owner` `null`, and **cannot** appear in `getCollections`, which enumerates the records
themselves. The runtime clears registrations through `pallet_scarcity::OnCollectionDeleted`, so it
should not arise. It is reported rather than papered over.

## Quick Start

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { getClaimableCollections, getCollectionItems } from "@parity/product-sdk-nfts";

const chain = await getChainAPI("paseo");

const registry = await getClaimableCollections(chain);
if (registry.ok) {
    for (const collection of registry.value.collections) {
        // id, name | null, selection, itemCount | null, owner | null
        console.log(collection.id, collection.name ?? `Collection ${collection.id}`);
    }
}

const catalogue = await getCollectionItems(chain, 3);
if (catalogue.ok && catalogue.value.tag === "Found") {
    for (const item of catalogue.value.collection.items) {
        console.log(item.index, item.name, `${item.liveSupply}/${item.supply}`);
    }
}
```

Both take an optional `{ signal }`, forwarded into every underlying pull so an aborted caller
stops the whole batch. No deadline is applied for you.

## What You Must Hand In

A **chain client**, not a typed API. `NftsChain` asks for six storage entries *and*
`raw.assetHub.getFinalizedBlock()`, because each read pins one finalized block before it touches
storage.

```typescript
// Either of these satisfies NftsChain whole:
const preset = await getChainAPI("paseo");
const byod = await createChainClient({ chains: { assetHub: paseo_asset_hub } });

// A TypedApi does NOT, however complete its query surface is: it has no `raw`,
// so `chain.raw.assetHub` is undefined and the read fails before it queries.
const api = rawClient.getTypedApi(paseo_asset_hub);
```

An app that keeps only the typed API in its own session type (a common shape: `{ assetHub,
people }`) has to thread the client, or at least its `raw`, through to call these reads.

The contract is structural on purpose, no genesis hash is pinned to read a catalogue, and it is
checked at compile time from `@parity/product-sdk`, in `packages/sdk/src/nfts/contract.test.ts`.

## Pruned Descriptors

These reads touch six entries:

```
query.Scarcity.NextCollectionId     query.Scarcity.Collections
query.Scarcity.ItemDefs             query.Scarcity.CollectionMetadata
query.Scarcity.ItemMetadata         query.NftClaims.CollectionMinters
```

An app that prunes its own descriptors with a PAPI whitelist (`.papi/whitelist.ts`) must list all
six, **including the ones its own code never reads**. An app resolving display metadata through
`ScarcityApi.metadata_batch` typically carries none of the three metadata/`ItemDefs` entries, so
this bites on the first call.

The symptom is the PAPI `Incompatible runtime entry Storage(Scarcity.CollectionMetadata)`, which
reads like descriptor drift and is not. These reads report it as `NftsChainEntryError`, which names
the entry in its message, carries it on `error.entry` for programmatic handling, and keeps PAPI's
error as the `cause`.

Two follow-ons that cost real time:

- Regenerating descriptors is not the whole fix when they are installed as a `file:` dependency
  (`"@polkadot-api/descriptors": "file:.papi/descriptors"`). The package manager keeps serving the
  copy in its store until a forced reinstall (`pnpm install --force`).
- `devnet-asset-hub` carries neither `Scarcity` nor `NftClaims`, so nothing here can run against
  the devnet preset. That failure is also a `NftsChainEntryError`, from the other PAPI message
  (`Runtime entry Storage(...) not found`).

## Metadata Is an Open Schema

`Scarcity` stores metadata as untyped `Vec<u8>` keys to `Vec<u8>` values in three layers, each overriding the
last for the same key. A catalogue read merges the first two, collection defaults underneath and the
item overrides on top. `InstanceMetadata` is deliberately not consulted: it keys on an instance
id, so it describes a minted NFT rather than a catalogue entry.

Nothing in the runtime declares the keys or their types.

- `name` and `rarity` are lifted into typed fields, and every key is also passed through in
  `attributes`.
- Values decode as UTF-8 when the bytes are readable text, `0x`-hex otherwise.
- **Numbers are never parsed**, and nothing is lost by that. On one deployment `energy` holds the
  two ASCII characters `2` and `1`. The chain stored the text `"21"` there, not a binary number.
  Parse the string yourself and decide what a malformed one means.
- `imageRef` is an `ImageRef`: the same bytes as `hex` (always) and as `text` (`null` when they
  are not readable). Deployments disagree, one stores a 32-byte content digest and another an ASCII
  IPFS CID, and nothing says which, so pick by your own convention:

```typescript
const src = item.imageRef?.text            // an ASCII CID, when that is what is stored
    ?? cidFromDigest(item.imageRef?.hex);  // your own digest to CID step otherwise
```

- `transferability` is **not** returned. It traces to `pallet_nfts`'
  `CollectionSetting::TransferableItems` and has no source in `Scarcity`.

## Results, and the One Success Value That Looks Like an Error

Every read returns a `Result`, so failures arrive on the `err` channel rather than as throws.

```typescript
const catalogue = await getCollectionItems(chain, 9);
if (!catalogue.ok) {
    // ProductNftsError; NftsChainEntryError or NftsDecodeError when it is one of those
    return;
}
if (catalogue.value.tag === "NotFound") {
    // A collection nobody created. The chain was asked and answered, not an error.
    return;
}
catalogue.value.collection.items;
```

`getClaimableCollections` is driven by `NftClaims.CollectionMinters`, not by `Scarcity.Collections`: a
collection with no minter entry cannot be claimed into, so it does not belong in a picker even
though its catalogue exists. How much that removes is per deployment. One carries six collections
and registers one, another registers most of what it carries, so do not assume the registry is
tiny, or that it matches the catalogue.

Narrow errors with `isErrorOf(e, NftsChainEntryError)` from `@parity/result`, or recognise any SDK
error with `isSdkError(e)` from `@parity/product-sdk-errors`.

Every value in one result is read at a single pinned finalized block, reported as `at`
(`{ blockHash, blockNumber }`). Two reads in sequence pin two blocks. A walk can outlive its pinned block. When a page fails on the `err` channel mid-walk, drop `at`, read again from the last `nextId`, and continue on the new snapshot.

## Credits, Preview and Artwork

Three more reads, for the claim side of the same pallets.

`getCredits(chain, { claimant })` reads every NFT claim credit one claimant holds. A credit is
awarded on the People chain and spent on Asset Hub, so this is the one read here that spans two
chains: it takes `NftsChain & NftsCreditsChain`, pins one block on each, and reports both in `at`.
A claimant is `{ tag: "Account", address }` or `{ tag: "Person", alias }`, and the pallet keys the
two apart with nothing linking them, so a player who moved from account to alias has to be read
twice. Each credit carries a `state`:

| `state` | Meaning |
|---|---|
| `earned` | Awarded, and the award block has no root on Asset Hub yet. A claim would be refused. |
| `claimable` | The root arrived and the leaf is unspent. |
| `claimed` | The leaf is spent. The item it minted exists somewhere. Stays claimed after Asset Hub sweeps the tree. |
| `unprovable` | The awards of the block are gone, pruned or expired. One entry per block, `hash: null`, credit count unknown. |

An `earned` entry with `hash: null` is a block still to come. Pass only non-null hashes to
`previewClaim`.

`previewClaim(chain, { credit, collections })` answers what that credit would mint in each
collection, in one `NftClaimsApi.preview_mints` call. It runs the real claim selector, so for a
`Random` collection the preview is the item the claim will produce, and switching collection is the
only way to change it. A collection the credit cannot mint into is a `Fails` outcome with the
reason, not an error. The item that would mint is resolved through the same exact-key metadata path
a catalogue page uses, so its `name`, `rarity` and `imageRef` agree with `getCollectionItems`.

```typescript
const registry = await getClaimableCollections(chain);
if (!registry.ok) return;
const preview = await previewClaim(chain, {
    credit,
    collections: registry.value.collections.map((c) => c.id),
    at: registry.value.at,
});
```

`getVerifiedArtwork(imageRef, { source })` turns an `ImageRef` into bytes, and only when the bytes
hash to the digest the reference names. Where the bytes come from is the caller's `source`:
`preimageSource(manager)` over the host preimage manager, whose key is the digest, or
`gatewaySource(baseUrl)` over an IPFS gateway by CID. The four outcomes are all on the `ok` channel:
`Verified` with the bytes, `Missing`, `Mismatch` with the bytes withheld, and `Unreadable` when the
reference decodes to no address.

## Not Built Yet

- **Nothing purse-scoped.** `getOwnedNfts`, `getNextEmptyPurse` and `findPurseHolding` need a purse
  primitive shared across apps, which the wallet does not expose. App-scoped product-account
  derivation is not a substitute: it is keyed by `productId`, so nothing derived under it can be
  shared between two apps.

## Common Mistakes

1. **Passing a `TypedApi`.** The reads pin a block first, so they need the client. The failure is
   a `TypeError` about reading `assetHub` of undefined, wrapped as `ProductNftsError`.
2. **Forgetting the whitelist entries** in an app that prunes descriptors, then reading
   `Incompatible runtime entry` as descriptor drift.
3. **Regenerating descriptors without a forced reinstall.** The old copy keeps answering.
4. **Reaching for `imageRef.hex` on a CID deployment** (or `.text` on a digest one). Check which
   field is populated rather than assuming.
5. **Treating `NotFound` as an error.** It is on the `ok` channel, with the block it was
   established at.
6. **Checking `result.tag`** instead of `result.ok` first. The tag is inside `result.value`.
7. **Reading `itemCount` as `items.length`.** They are separate writes and can disagree while a
   definition is being removed. Both are reported as the chain has them.
8. **Assuming a `ClaimableCollection` has a `Scarcity.Collections` record.** `itemCount` and `owner`
   are `null` when it does not, which signals an inconsistency rather than an empty collection.
9. **Parsing `attributes` values as numbers** without handling text that is not numeric.
10. **Expecting `rarity` or `name` to be set.** Most collections on a live deployment set neither.
