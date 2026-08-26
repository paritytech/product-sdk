---
name: product-sdk-nfts
description: >
  Use when reading Scarcity NFT collections or their item catalogues on Asset Hub — which
  collections a claim can mint into, every collection on chain, and what one of them holds. Covers
  getClaimableCollections, getCollections and getCollectionItems, the one storage map that
  separates claimable from merely existing, the chain client they require and why a TypedApi is not
  enough, the five
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
- `getCollectionItems(chain, id, options?)` — one collection's full item catalogue. Applies **no**
  registry filter; a collection nobody created comes back as `{ tag: "NotFound" }`.

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

- **Picker / spending a credit** → `getClaimableCollections`. `getCollections` pays a metadata
  read for every collection to hand back ones a claim cannot use.
- **Browsing, gallery, audit** → `getCollections`. `selection === null` means "exists but accepts
  no claims", and it is the only signal — there is no separate `claimable` boolean to drift.
- **One known id** → `getCollectionItems`. No registry filter either.

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

A **chain client**, not a typed API. `NftsChain` asks for five storage entries *and*
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

These reads touch five entries:

```
query.Scarcity.Collections          query.Scarcity.ItemDefs
query.Scarcity.CollectionMetadata   query.Scarcity.ItemMetadata
query.NftClaims.CollectionMinters
```

An app that prunes its own descriptors with a PAPI whitelist (`.papi/whitelist.ts`) must list all
five, **including the ones its own code never reads**. An app resolving display metadata through
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
- **Numbers are never parsed.** One deployment's `energy` is the two bytes `"21"` — text, not a
  SCALE integer. Parse it yourself and decide what a malformed one means.
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
