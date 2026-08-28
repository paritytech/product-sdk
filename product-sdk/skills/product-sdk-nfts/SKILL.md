---
name: product-sdk-nfts
description: >
  Use when reading Scarcity NFT collections or their item catalogues on Asset Hub — which
  collections a claim can mint into, every collection on chain, and what one of them holds. Covers
  getClaimableCollections, getCollections and getCollectionItems, the one storage map that
  separates claimable from merely existing, the chain client they require and why a TypedApi is not
  enough, the six
  descriptor entries they touch and what a pruned whitelist does, the open metadata schema and
  ImageRef's two readings, why a missing collection is a success value rather than an error, and
  the purse-scoped reads that do not exist yet.
---

# Product SDK NFTs

`@parity/product-sdk-nfts` reads the Scarcity catalogue on Asset Hub. Three functions, all pure
reads, none needing an identity, a purse or a second chain. Also available as
`@parity/product-sdk/nfts`, the same code re-exported from `@parity/product-sdk`.

- `getClaimableCollections(chain, options?)` — collections registered to accept claims. Powers a
  picker. Every entry has a `selection`.
- `getCollections(chain, options?)` — every collection on chain, `selection` `null` where none is
  registered. For browsing or auditing.
- `getCollectionItems(chain, id, options?)` — one page of a collection's item catalogue. Applies
  **no** registry filter; a collection nobody created comes back as `{ tag: "NotFound" }`. Pass
  `attributes: true` for the open metadata bag.

## Everything Is Paged

**No read here is unbounded, and `limit` omitted does not mean "everything".** It defaults to
`DEFAULT_PAGE_LIMIT` (100) and caps at `MAX_PAGE_LIMIT` (1000), both exported. Nothing on chain
bounds how many collections exist or how many items a collection holds — the pallet's only ceilings
are index-space exhaustion and the indices are `u32` — so a read defaulting to "everything" is one
that works until a deployment grows and then breaks a browser tab.

One vocabulary for all three reads, so a single pager works against any of them:

| in | out |
|---|---|
| `limit`, `fromId` | `idCeiling`, `nextId` |

`nextId === null` is **the only end signal** — a page can be short of `limit` without being the
last, when a stretch of deleted or unregistered ids exhausts the scan budget. Follow the cursor
rather than counting results.

## One Kind Of Collection, Two Sets

There is **one** kind of collection. Two maps in two pallets describe it:

```
Scarcity.Collections         id -> { owner, item_count, … }   the collection exists
NftClaims.CollectionMinters  id -> { owner, selection }       the owner opted in via
                                                              set_collection_minter
```

`CollectionMinters` is not a second type of collection — it is an opt-in flag plus config, and its
keys are a **subset** of `Scarcity.Collections`' keys. So `getCollections` is the superset and
`getClaimableCollections` is what the registry leaves of it. How much that removes is per
deployment: one carries six collections and registers one, another registers most of what it
carries, so neither read stands in for the other.

Which to reach for:

- **Picker / spending a credit** → `getClaimableCollections`. A collection with no minter entry
  cannot be claimed into, so it does not belong in the list.
- **Browsing, gallery, audit** → `getCollections`. `selection === null` means "exists but accepts
  no claims", and it is the only signal — there is no separate `claimable` boolean to drift.
- **One known id** → `getCollectionItems`. No registry filter either.

All three are four round trips, whatever the counts — so pick by which set you want. But the
**bytes** differ, and that is what matters as a chain fills up:

| Read | Scales with |
|---|---|
| `getClaimableCollections` | the registry — proportional to the answer |
| `getCollections` | the whole chain, claimable or not |
| `getCollectionItems` | one collection's catalogue |

Prefer `getClaimableCollections` whenever only claimable collections belong in the answer.

### Paging `getCollections`

**`getCollections` is always paged**, at 100 collections per page by default. Dumping the maps
whole would cost around 15 MB at ten thousand collections, most of it discarded, because the
metadata dump carries every key when only `name` is wanted.

```typescript
const first = await getCollections(chain, { limit: 100 });
if (!first.ok) return;
render(first.value.collections);

// Pass the first page's snapshot back in, so the whole walk addresses one block.
let fromId = first.value.nextId;
while (fromId !== null) {
    const page = await getCollections(chain, { fromId, limit: 100, at: first.value.at });
    if (!page.ok) break;
    render(page.value.collections);          // 100, ascending by id
    fromId = page.value.nextId;              // null when the id space is exhausted
}
```

**Pass `at` when you page.** Without it every page pins its own finalized block, so the walk is not
a walk of any single chain state — `itemCount` can move under you and a collection deleted
mid-walk vanishes. `at` takes a `FinalizedSnapshot` straight from another result and costs no round
trip. Every read in this package accepts it, so a catalogue read can also address the block the
listing came from. The node must still have the block pinned, so reuse a recent snapshot rather
than a stale one.

Four storage reads per page — the id ceiling plus three keyed reads over the window — whatever
the chain holds. It works because ids are allocated
sequentially by the runtime (`create_collection` takes no id) and **never reused**
(`delete_collection` says so), so `Scarcity.NextCollectionId` bounds the space and every id in a
window can be read by exact key.

Two consequences worth knowing:

- **A page comes back full.** Deleted ids are holes, and the read walks past them rather than
  handing back a short page — ask for 100, get 100. It is short only at the end of the id space,
  or if a mostly-deleted range exhausts the scan budget, so **follow `nextId` rather than counting**:
  `nextId === null` is the only end signal. Stepping over holes costs one extra record read; a hole
  never gets a name or registry lookup.
- **Resuming by id is stable.** Ids are only ever appended, so paging forward cannot skip or
  duplicate a collection even while the chain is written to — a guarantee offset-based paging
  cannot give.

`getClaimableCollections` takes the same `limit`, `fromId`, `nextId` and `at`. One difference:

- **Its pages fill only while the chain is reasonably registered.** The gaps its walk steps over
  are unregistered collections, not deleted ones, and there can be many: at one collection in fifty
  registered, a page of 10 comes back with 4 and `nextId` set. A short page is not the end — follow
  `nextId`, and on a registry that sparse the rest of it arrives in a few more pages.

`itemCount` from either listing read tells you a collection's size without reading its items.

### Paging a catalogue

**Nothing on chain caps a collection's size.** The pallet's only item ceiling is index-space
exhaustion — `TooManyItems` is documented as "the per-collection item index space is exhausted", and
the index is a `u32`. So there is no configured limit to rely on, and 10,000 items (≈70,000 metadata
rows, ~14 MB in one response) is an afternoon's work for a collection owner.

```typescript
const first = await getCollectionItems(chain, id, { limit: 100 });
if (!first.ok || first.value.tag !== "Found") return;
const at = first.value.at;                       // pin the whole walk to one block

let page = first.value;
for (;;) {
    render(page.collection.items);
    if (page.nextId === null) break;              // the only end signal
    const result = await getCollectionItems(chain, id, { limit: 100, fromId: page.nextId, at });
    if (!result.ok || result.value.tag !== "Found") break;
    page = result.value;
}
```

**A page carries the typed fields; `attributes` is opt-in.** `ItemMetadata` is keyed
`(collection, item, key)`, so keys the SDK can name (`name`, `image`, `rarity`) come back for a whole
window in one exact-key read. The open bag's keys are unknowable in advance, so filling it means a
prefix scan of **the whole collection's** item metadata — still one read, but bytes proportional to
the catalogue rather than to the page. Pass `attributes: true` for a collection you know is small, or
when a caller genuinely needs app-specific keys. Left off, `attributes` is `null` — "not fetched",
a different claim from an empty bag meaning "this item has no metadata".

Collection-level defaults are inherited either way, so an item resolves `name` / `image` / `rarity`
from its collection where it does not override them. `idCeiling` counts every item index ever
allocated (indices are never reused); `itemCount` counts the live ones.

The two disagree in one edge case, in opposite directions. A minter entry whose
`Scarcity.Collections` record is missing appears in `getClaimableCollections` with `itemCount` and
`owner` `null`, and **cannot** appear in `getCollections`, which enumerates the records
themselves. The runtime clears registrations through `pallet_scarcity::OnCollectionDeleted`, so it
should not arise — it is reported rather than papered over.

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

The contract is structural on purpose — no genesis hash is pinned to read a catalogue — and it is
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

The symptom is PAPI's `Incompatible runtime entry Storage(Scarcity.CollectionMetadata)`, which
reads like descriptor drift and is not. These reads report it as `NftsChainEntryError`, which names
the entry in its message, carries it on `error.entry` for programmatic handling, and keeps PAPI's
error as the `cause`.

Two follow-ons that cost real time:

- Regenerating descriptors is not the whole fix when they are installed as a `file:` dependency
  (`"@polkadot-api/descriptors": "file:.papi/descriptors"`). The package manager keeps serving the
  copy in its store until a forced reinstall (`pnpm install --force`).
- `devnet-asset-hub` carries neither `Scarcity` nor `NftClaims`, so nothing here can run against
  the devnet preset. That failure is also a `NftsChainEntryError`, from PAPI's other message
  (`Runtime entry Storage(...) not found`).

## Metadata Is an Open Schema

`Scarcity` stores metadata as untyped `Vec<u8>` → `Vec<u8>` in three layers, each overriding the
last for the same key. A catalogue read merges the first two — collection defaults underneath, the
item's overrides on top. `InstanceMetadata` is deliberately not consulted: it keys on an instance
id, so it describes a minted NFT rather than a catalogue entry.

Nothing on chain declares the keys or their types.

- `name` and `rarity` are lifted into typed fields, and every key is also passed through in
  `attributes`.
- Values decode as UTF-8 when the bytes are readable text, `0x`-hex otherwise.
- **Numbers are never parsed**, and nothing is lost by that. One deployment's `energy` holds the
  two ASCII characters `2` and `1` — the chain stored the text `"21"` there, not a binary number.
  Parse the string yourself and decide what a malformed one means.
- `imageRef` is an `ImageRef`: the same bytes as `hex` (always) and as `text` (`null` when they
  are not readable). Deployments disagree — one stores a 32-byte content digest, another an ASCII
  IPFS CID — and nothing on chain says which, so pick by your own convention:

```typescript
const src = item.imageRef?.text            // an ASCII CID, when that is what is stored
    ?? cidFromDigest(item.imageRef?.hex);  // your own digest → CID step otherwise
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
    // A collection nobody created. The chain was asked and answered — not an error.
    return;
}
catalogue.value.collection.items;
```

`getClaimableCollections` is driven by `NftClaims.CollectionMinters`, not by `Scarcity.Collections`: a
collection with no minter entry cannot be claimed into, so it does not belong in a picker even
though its catalogue exists. How much that removes is per deployment — one carries six collections
and registers one, another registers most of what it carries — so do not assume the registry is
tiny, or that it matches the catalogue.

Narrow errors with `isErrorOf(e, NftsChainEntryError)` from `@parity/result`, or recognise any SDK
error with `isSdkError(e)` from `@parity/product-sdk-errors`.

Every value in one result is read at a single pinned finalized block, reported as `at`
(`{ blockHash, blockNumber }`). Two reads in sequence pin two blocks.

## Not Built Yet

- **Nothing purse-scoped.** `getOwnedNfts`, `getNextEmptyPurse` and `findPurseHolding` need a purse
  primitive shared across apps, which the wallet does not expose. App-scoped product-account
  derivation is not a substitute: it is keyed by `productId`, so nothing derived under it can be
  shared between two apps.
- **`previewClaim`.** It needs `NftClaimsApi.preview_mints`, which is not reachable through the
  pinned descriptor, and has no storage equivalent. Display metadata needs no such API — the
  `CollectionMetadata` / `ItemMetadata` storage layers answer the same question.

## Common Mistakes

1. **Passing a `TypedApi`** — the reads pin a block first, so they need the client. The failure is
   a `TypeError` about reading `assetHub` of undefined, wrapped as `ProductNftsError`.
2. **Forgetting the whitelist entries** in an app that prunes descriptors, then reading
   `Incompatible runtime entry` as descriptor drift.
3. **Regenerating descriptors without a forced reinstall** — the old copy keeps answering.
4. **Reaching for `imageRef.hex` on a CID deployment** (or `.text` on a digest one). Check which
   field is populated rather than assuming.
5. **Treating `NotFound` as an error** — it is on the `ok` channel, with the block it was
   established at.
6. **Checking `result.tag`** instead of `result.ok` first. The tag is inside `result.value`.
7. **Reading `itemCount` as `items.length`** — they are separate writes and can disagree while a
   definition is being removed. Both are reported as the chain has them.
8. **Assuming a `ClaimableCollection` has a `Scarcity.Collections` record** — `itemCount` and `owner`
   are `null` when it does not, which signals an inconsistency rather than an empty collection.
9. **Parsing `attributes` values as numbers** without handling text that is not numeric.
10. **Expecting `rarity` or `name` to be set** — most collections on a live deployment set neither.
