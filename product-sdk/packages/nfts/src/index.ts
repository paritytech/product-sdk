// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-nfts — read Scarcity NFT collections and their item
 * catalogues on Asset Hub.
 *
 * Three reads today, all of them pure catalogue: which collections a claim can
 * mint into, every collection on chain whether it accepts claims or not, and
 * what is in one of them. None needs an identity, a purse, or a second chain,
 * which is why they came first.
 *
 * `getClaimableCollections` and `getCollections` are the subset and the
 * superset of the same thing — there is one kind of collection, and a
 * `NftClaims.CollectionMinters` entry is what makes one claimable. Pick the
 * first for a picker; the second pays metadata for collections a claim cannot
 * use.
 *
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 * import { getClaimableCollections, getCollectionItems } from "@parity/product-sdk-nfts";
 *
 * const chain = await getChainAPI("paseo");
 *
 * const registry = await getClaimableCollections(chain);
 * if (registry.ok) {
 *     for (const collection of registry.value.collections) {
 *         console.log(collection.id, collection.name ?? "(unnamed)");
 *     }
 * }
 *
 * const catalogue = await getCollectionItems(chain, 0);
 * if (catalogue.ok && catalogue.value.tag === "Found") {
 *     console.log(catalogue.value.collection.items);
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
 * # Descriptor whitelists
 *
 * These reads touch five entries:
 *
 * ```
 * query.Scarcity.Collections          query.Scarcity.ItemDefs
 * query.Scarcity.CollectionMetadata   query.Scarcity.ItemMetadata
 * query.NftClaims.CollectionMinters
 * ```
 *
 * An app that prunes its own descriptors with a PAPI whitelist has to list all
 * five, including the ones its own code never reads. A missing entry surfaces as
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
    CollectionSummary,
    RawBytes,
    ReadAt,
} from "./types.js";
