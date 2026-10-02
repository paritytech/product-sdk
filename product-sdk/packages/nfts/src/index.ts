// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-nfts reads Scarcity NFT collections and item catalogues on Asset Hub.
 *
 * Three catalogue reads, all of them paged: which collections a claim can mint
 * into, every collection whether it accepts claims or not, and what is in one
 * of them. None needs an identity, a purse, or a second chain, which is why
 * they came first. Beside them, `getInstanceDisplays` describes *minted* NFTs
 * by instance id — what somebody holds rather than what a collection defines.
 * It is instance-keyed, so it too needs no purse: the caller says which
 * instances, however it learned of them.
 *
 * `getClaimableCollections` and `getCollections` are the subset and the
 * superset of the same thing. There is one kind of collection, and a
 * `NftClaims.CollectionMinters` entry is what makes one claimable. Both are four
 * reads a page, so pick by which set you want. Prefer the registry read when
 * only claimable collections belong in the answer.
 *
 * **Every catalogue read is paged, and none of them is unbounded.** `limit`
 * defaults to {@link DEFAULT_PAGE_LIMIT} and caps at {@link MAX_PAGE_LIMIT};
 * there is no "give me everything", because nothing bounds how many collections
 * exist or how many items a collection holds. The only ceilings the pallet has
 * are index-space exhaustion, and the indices are `u32`. Follow `nextId` to
 * walk the whole of anything, in bounded pieces. The positional reads,
 * `previewClaim` and `getInstanceDisplays`, are bounded by their input instead:
 * they answer exactly the list they were given, in its order.
 *
 * One vocabulary across all three reads: `limit` and `fromId` in, `idCeiling` and
 * `nextId` out, so a single pager works against any of them.
 *
 * A page is four storage reads whatever the counts, but four reads is not four
 * round trips. The PAPI `getValues` opens one storage operation per key, so the
 * operations of a page scale with `limit` while its bytes stay flat. That is the
 * other half of why {@link MAX_PAGE_LIMIT} exists.
 *
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 * import {
 *     getClaimableCollections,
 *     getCollectionItems,
 *     getInstanceDisplays,
 * } from "@parity/product-sdk-nfts";
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
 * // A page of the catalogue of one collection. `attributes` is `null` unless asked for.
 * const catalogue = await getCollectionItems(chain, 0, { limit: 20 });
 * if (catalogue.ok && catalogue.value.tag === "Found") {
 *     console.log(catalogue.value.collection.items, catalogue.value.nextId);
 * }
 *
 * // Minted NFTs by instance id, answered in the order asked. Not paged: the
 * // list is the bound. `NotFound` is an instance nobody minted, or a burned one.
 * const shelf = await getInstanceDisplays(chain, [0n, 1n, 2n]);
 * if (shelf.ok) {
 *     for (const display of shelf.value.displays) {
 *         if (display.tag === "NotFound") continue;
 *         console.log(display.name ?? "(unnamed)", display.collection, display.transferability);
 *     }
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
 * wrong for one question asked in pieces. A paged walk over its own snapshots
 * is not a walk of any single chain state. Pass the `at` of another result back in as
 * the `at` option to join its block instead: every read here accepts it, so a
 * whole walk, or a registry read and a catalogue read, can address one block.
 *
 * # Descriptor whitelists
 *
 * The catalogue reads touch six entries, all Asset Hub:
 *
 * ```
 * query.Scarcity.NextCollectionId     query.Scarcity.Collections
 * query.Scarcity.ItemDefs             query.Scarcity.CollectionMetadata
 * query.Scarcity.ItemMetadata         query.NftClaims.CollectionMinters
 * ```
 *
 * `previewClaim` adds one runtime API, `api.NftClaimsApi.preview_mints`.
 * `getInstanceDisplays` touches two entries, `api.ScarcityApi.metadata_batch`
 * and `query.Scarcity.ItemDefs`, the second shared with the catalogue reads.
 * `getClaims` adds two Asset Hub entries and four on the People chain:
 *
 * ```
 * query.NftClaims.CreditTrees         query.NftClaims.ClaimedLeaves
 * query.NftCredits.NftClaimCreditBlocks
 * query.NftCredits.NftClaimCreditAwards
 * api.NftCreditsApi.nft_claim_credit_roots
 * api.NftCreditsApi.nft_claim_credit_proofs
 * ```
 *
 * An app that prunes its own descriptors with a PAPI whitelist has to list every
 * entry a read it calls touches, including the ones its own code never reads. A missing entry surfaces as
 * the PAPI `Incompatible runtime entry Storage(...)`, which reads like descriptor
 * drift; these reads report it as {@link NftsChainEntryError} instead, which
 * names the entry in its message and carries it on `entry`.
 * Regenerating the descriptors is not the whole fix when they are installed as a
 * `file:` dependency, because the package manager keeps serving the previous
 * copy until a forced reinstall.
 *
 * # What this package deliberately does not do yet
 *
 * - **Two runtime APIs, and both earned it.** Display metadata of a *catalogue*
 *   is read from the `CollectionMetadata` / `ItemMetadata` storage layers, which
 *   answer the same question and are carried by the pinned descriptor.
 *   `previewClaim` has no storage equivalent, so `preview_mints` is one
 *   exception; `metadata_batch` is the other, because storage answers an
 *   *instance's* metadata only through two serial owner-keyed hops before the
 *   three layers can even be addressed (see `NftsInstancesChain`). The fidelity
 *   guard in `@parity/product-sdk` checks both signatures against the
 *   descriptor the same way it checks the storage entries.
 * - **`attributes` costs a prefix scan of the whole collection.** The typed
 *   fields are keys this package can name, so a page fetches them for its window
 *   in one exact-key read. The keys of the open bag are not knowable in advance, so
 *   filling it means scanning the item metadata of one collection whole. That is one
 *   read, but bytes proportional to the catalogue rather than the page. Left off, the
 *   field is `null`, which says "not fetched" rather than "no metadata".
 * - **Nothing bounds the size of a collection.** The only item ceiling the pallet
 *   has is index-space exhaustion. `TooManyItems` reads "the per-collection
 *   item index space is exhausted", and the index is a `u32`, so there is no
 *   configured limit to lean on and a ten-thousand-item collection is an
 *   afternoon of work. That is why `getCollectionItems` pages like the listing
 *   reads do, rather than assuming a small catalogue. `itemCount` from either
 *   listing read gives the size before you commit to walking a collection
 *   whole.
 * - **Nothing purse-scoped.** `getOwnedNfts`, `getNextEmptyPurse` and
 *   `findPurseHolding` all need a purse primitive shared across apps, which the
 *   wallet does not expose yet. App-scoped product-account derivation is not a
 *   substitute: it is keyed by `productId`, so nothing derived under it can be
 *   shared between two SPAs. `getInstanceDisplays` already answers the display
 *   half of an owned read — once a purse primitive can enumerate what is held,
 *   the owned read composes on it rather than growing its own metadata path.
 * - **Metadata keys are a convention, not a contract.** Nothing in the runtime
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
// the catalogue of one collection and filters by nothing.
export { getClaimableCollections, getCollections } from "./collections.js";
export type {
    CollectionsResult,
    ClaimableCollectionsResult,
    GetCollectionsOptions,
    GetClaimableCollectionsOptions,
} from "./collections.js";
export { getCollectionItems } from "./items.js";
export type { GetCollectionItemsOptions } from "./items.js";

// The credits read spans two chains, so it takes `NftsChain & NftsCreditsChain`.
export { getClaims, toClaimantKey } from "./claims.js";
export type { GetClaimsOptions } from "./claims.js";

// What a credit would mint, per collection, from the real claim selector.
export { previewClaim } from "./preview.js";
export type { PreviewClaimOptions } from "./preview.js";

// The display metadata of minted NFTs by instance id, positional like
// `previewClaim`. A missing instance is `NotFound` on the ok channel; an
// existing one with no metadata is `Found` with an empty bag.
export { getInstanceDisplay, getInstanceDisplays, METADATA_BATCH_LIMIT } from "./instances.js";

// The bytes an image reference names, and only when they hash to it. No chain
// read: the source is the caller's, the check is this package's.
export { artworkAddress, gatewaySource, getVerifiedArtwork, preimageSource } from "./artwork.js";
export type {
    ArtworkAddress,
    ArtworkSource,
    GetVerifiedArtworkOptions,
    VerifiedArtwork,
} from "./artwork.js";

// The paging vocabulary every read shares: `limit` defaults to one constant and
// caps at the other, and the scan budget is how far past `limit` a sparse page
// may read before it comes back short.
export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, SCAN_BUDGET_FACTOR } from "./paging.js";

// The chain contracts the reads take: the entries each needs and the raw client
// they pin with, structural so no genesis hash is pinned to read a catalogue.
export type {
    BlockSource,
    Entry,
    NftsChain,
    NftsCreditsChain,
    NftsInstancesChain,
} from "./chain.js";

// `NftsChainEntryError` is the one worth narrowing on: it means the client
// cannot read an entry this package needs, which no retry will fix.
export {
    ProductNftsError,
    NftsChainEntryError,
    NftsDecodeError,
    NftsIdError,
} from "./errors.js";

// The metadata convention is deliberately *not* exported. Callers get decoded
// fields off the reads above, `name`, `rarity`, `imageRef` and `attributes`, not
// the primitives to assemble them from. `decodeMetadataValue` collapses bytes to
// one reading, `imageRefFrom` needs raw layers in precedence order, and
// `mergeMetadata` is one `Object.assign`; handing those out asks the caller to
// re-derive the layering and the text/bytes question we already answered. The
// read of instance metadata arrived exactly this way: `getInstanceDisplays`
// returns finished shapes, and the helpers stayed inside.

// The shapes the reads return, and the raw storage shapes behind them.
export type {
    Claimant,
    Claim,
    ClaimState,
    ClaimsResult,
    CollectionDetail,
    CollectionItem,
    CollectionItemsResult,
    BlockAt,
    BlockSnapshot,
    FinalizedSnapshot,
    ImageRef,
    InstanceDisplay,
    InstanceDisplayResult,
    InstanceDisplaysResult,
    ItemSelection,
    MintPreview,
    MintPreviewResult,
    RawMintOutcome,
    PinnedReadOptions,
    ClaimableCollection,
    Collection,
    RawBytes,
    RawCollection,
    RawCreditAward,
    RawCreditProof,
    RawCreditRoot,
    RawItemDef,
    Transferability,
    RawMetadataEntry,
    RawMetadataLayers,
    RawMetadataQuery,
    RawMetadataTarget,
    RawMinter,
    ReadAt,
    RuntimeResult,
} from "./types.js";
