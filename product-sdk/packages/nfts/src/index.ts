// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-nfts — Read Scarcity NFT collections and item catalogues on Asset Hub.
 *
 * Three reads today, all of them pure catalogue and all of them paged: which
 * collections a claim can mint into, every collection on chain whether it accepts
 * claims or not, and what is in one of them. None needs an identity, a purse, or a second chain,
 * which is why they came first.
 *
 * `getClaimableCollections` and `getCollections` are the subset and the
 * superset of the same thing — there is one kind of collection, and a
 * `NftClaims.CollectionMinters` entry is what makes one claimable. Both are four
 * reads a page, so pick by which set you want — but prefer the registry read when
 * only claimable collections belong in the answer.
 *
 * **Every read is paged, and none of them is unbounded.** `limit` defaults to
 * {@link DEFAULT_PAGE_LIMIT} and caps at {@link MAX_PAGE_LIMIT}; there is no
 * "give me everything", because nothing on chain bounds how many collections
 * exist or how many items a collection holds — the pallet's only ceilings are
 * index-space exhaustion, and the indices are `u32`. Follow `nextId` to walk the
 * whole of anything, in bounded pieces.
 *
 * One vocabulary across all three reads: `limit` and `fromId` in, `idCeiling` and
 * `nextId` out, so a single pager works against any of them.
 *
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 * import { getClaimableCollections, getCollectionItems } from "@parity/product-sdk-nfts";
 *
 * const chain = await getChainAPI("paseo");
 *
 * // A page of the claim registry, and where the next one starts.
 * const registry = await getClaimableCollections(chain, { limit: 20 });
 * if (registry.ok) {
 *     for (const collection of registry.value.collections) {
 *         console.log(collection.id, collection.name ?? "(unnamed)");
 *     }
 *     console.log(registry.value.nextId); // null when the id space is exhausted
 * }
 *
 * // A page of one collection's catalogue. `attributes` is `null` unless asked for.
 * const catalogue = await getCollectionItems(chain, 0, { limit: 20 });
 * if (catalogue.ok && catalogue.value.tag === "Found") {
 *     console.log(catalogue.value.collection.items, catalogue.value.nextId);
 * }
 * ```
 *
 * Failures arrive on the `err` channel as a {@link ProductNftsError}, per the
 * SDK-wide error model. A collection that does not exist is not a failure: it is
 * `ok({ tag: "NotFound", … })`.
 *
 * Every value in one result is read at a single pinned finalized block, reported
 * as `at`. A catalogue pulls item definitions and two metadata layers
 * separately, and reading them a block apart could return a catalogue the chain
 * was never in.
 *
 * Separate calls pin separate blocks, which is right for unrelated questions and
 * wrong for one question asked in pieces — a paged walk over its own snapshots
 * is not a walk of any single chain state. Pass another result's `at` back in as
 * the `at` option to join its block instead: every read here accepts it, so a
 * whole walk, or a registry read and a catalogue read, can address one block.
 *
 * # Descriptor whitelists
 *
 * These reads touch six entries:
 *
 * ```
 * query.Scarcity.NextCollectionId     query.Scarcity.Collections
 * query.Scarcity.ItemDefs             query.Scarcity.CollectionMetadata
 * query.Scarcity.ItemMetadata         query.NftClaims.CollectionMinters
 * ```
 *
 * An app that prunes its own descriptors with a PAPI whitelist has to list all
 * six, including the ones its own code never reads. A missing entry surfaces as
 * PAPI's `Incompatible runtime entry Storage(...)`, which reads like descriptor
 * drift; these reads report it as {@link NftsChainEntryError} instead, which
 * names the entry in its message and carries it on `entry`.
 * Regenerating the descriptors is not the whole fix when they are installed as a
 * `file:` dependency, because the package manager keeps serving the previous
 * copy until a forced reinstall.
 *
 * # What this package deliberately does not do yet
 *
 * - **No runtime APIs.** Display metadata is read from the `CollectionMetadata`
 *   / `ItemMetadata` storage layers, which answer the same question and are
 *   carried by the pinned descriptor. `previewClaim` has no storage equivalent,
 *   so it waits on `NftClaimsApi.preview_mints` being reachable here.
 * - **No `transferability`.** It traces to `pallet_nfts`, not `Scarcity`, and has
 *   no source on chain — see {@link CollectionItem}.
 * - **`attributes` costs a prefix scan of the whole collection.** The typed
 *   fields are keys this package can name, so a page fetches them for its window
 *   in one exact-key read. The open bag's keys are not knowable in advance, so
 *   filling it means scanning one collection's item metadata whole — one read,
 *   but bytes proportional to the catalogue rather than the page. Left off, the
 *   field is `null`, which says "not fetched" rather than "no metadata".
 * - **Nothing bounds a collection's size on chain.** The pallet's only item
 *   ceiling is index-space exhaustion — `TooManyItems` reads "the per-collection
 *   item index space is exhausted", and the index is a `u32` — so there is no
 *   configured limit to lean on and a ten-thousand-item collection is an
 *   afternoon's work. That is why `getCollectionItems` pages like the listing
 *   reads do, rather than assuming a small catalogue. `itemCount` from either
 *   listing read gives the size before you commit to walking a collection
 *   whole.
 * - **Nothing purse-scoped.** `getOwnedNfts`, `getNextEmptyPurse` and
 *   `findPurseHolding` all need a purse primitive shared across apps, which the
 *   wallet does not expose yet. App-scoped product-account derivation is not a
 *   substitute: it is keyed by `productId`, so nothing derived under it can be
 *   shared between two SPAs.
 * - **Metadata keys are a convention, not a contract.** Nothing on chain
 *   declares them. `name`, `image` and `rarity` are lifted into typed fields
 *   because every deployment read so far carries them; the rest of the bag is
 *   passed through untouched. `image` is reported as hex and as text both, since
 *   deployments disagree about which of the two they store. Unconfirmed with the
 *   pallet team.
 *
 * @packageDocumentation
 */
// The three reads, each pinning its own finalized block. Two list collections
// and differ only in whether the claim registry filters them; the third reads
// one collection's catalogue and filters by nothing.
export { getClaimableCollections, getCollections } from "./collections.js";
export type {
    CollectionsResult,
    ClaimableCollectionsResult,
    GetCollectionsOptions,
    GetClaimableCollectionsOptions,
} from "./collections.js";
export { getCollectionItems } from "./items.js";
export type { GetCollectionItemsOptions } from "./items.js";

// The paging vocabulary every read shares: `limit` defaults to one and caps at
// the other, so no read here is unbounded by accident.
export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./paging.js";

// The chain contract both reads take: the storage entries and the raw client
// they pin with, structural so no genesis hash is pinned to read a catalogue.
export type { Entry, NftsChain } from "./chain.js";

// `NftsChainEntryError` is the one worth narrowing on: it means the client
// cannot read an entry this package needs, which no retry will fix.
export { ProductNftsError, NftsChainEntryError, NftsDecodeError } from "./errors.js";

// The metadata convention is deliberately *not* exported. Callers get decoded
// fields off the reads above — `name`, `rarity`, `imageRef`, `attributes` — not
// the primitives to assemble them from. `decodeMetadataValue` collapses bytes to
// one reading, `imageRefFrom` needs raw layers in precedence order, and
// `mergeMetadata` is one `Object.assign`; handing those out asks the caller to
// re-derive the layering and the text/bytes question we already answered. When
// `InstanceMetadata` becomes readable it should arrive as a read returning
// finished shapes, not as three exported helpers.

// The shapes the reads return, and the raw storage shapes behind them.
export type {
    CollectionDetail,
    CollectionItem,
    CollectionItemsResult,
    FinalizedSnapshot,
    ImageRef,
    ItemSelection,
    ClaimableCollection,
    Collection,
    RawBytes,
    ReadAt,
} from "./types.js";
