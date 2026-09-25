// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The shapes these reads return, and the raw storage shapes they are built from.
 */

/** The finalized block every value in one result was read at. */
export interface FinalizedSnapshot {
    blockHash: string;
    blockNumber: number;
}

/**
 * What every paged read here accepts besides its own window: the block to read
 * at, and the signal that stops it.
 */
export interface PinnedReadOptions {
    /**
     * Address a block a previous read already pinned, instead of pinning a new
     * one.
     *
     * Pass a `FinalizedSnapshot` straight from the `at` of another result. Without it
     * every call pins its own finalized block, which is right for unrelated
     * questions and wrong for one question asked in pages: a walk over its own
     * snapshots is not a walk of any single chain state. It is also how two reads
     * are made to agree, the registry and the full list at one block.
     *
     * The node must still have the block pinned, and a walk can outlive that. A
     * page that fails on the `err` channel mid-walk is not the end of the walk:
     * drop `at`, read again from the last `nextId`, and continue on the new
     * snapshot. The examples on each read show the shape.
     */
    at?: FinalizedSnapshot;
    /**
     * Forwarded into every underlying pull, so an aborted caller stops the whole
     * batch. No deadline is applied here, that belongs to the caller.
     */
    signal?: AbortSignal;
}

/** Whose credits to read: the People chain keys them by account or by person alias. */
export type Claimant = { tag: "Account"; address: string } | { tag: "Person"; alias: string };

/**
 * Where one credit stands between being awarded and being spent.
 *
 * `earned` means the People chain awarded it and Asset Hub has not yet received
 * the root of its award block, so a claim would be refused. `claimable` means the
 * root arrived and the leaf is unspent. `claimed` means the leaf is spent, so the
 * item it minted exists somewhere and the credit is done. `unprovable` means the
 * award block was pruned before its proofs were read, so the credit exists but
 * this read cannot produce the leaf a claim needs.
 */
export type CreditState = "earned" | "claimable" | "claimed" | "unprovable";

/** One NFT claim credit, as the People chain awarded it and Asset Hub sees it. */
export interface Credit {
    /** The credit hash, `0x` prefixed, as `NftClaimCreditAwards` stores it. */
    hash: string;
    /** The People chain block the credit was awarded in. */
    awardBlock: number;
    /**
     * When the award block was rooted, in Unix seconds, or `null` for a block
     * whose root has not been recorded yet.
     */
    awardedAt: number | null;
    /** The game the award block belongs to, or `null` before its root exists. */
    gameIndex: number | null;
    /**
     * Where the credit sits in the tree of its award block, which a proof binds
     * to it and a claim spends, or `null` while the block is rootless or once
     * its awards were pruned.
     */
    leafIndex: number | null;
    state: CreditState;
}

/** What one `getCredits` call returns. */
export interface CreditsResult {
    /** Two chains, so two pinned blocks. Every value came from one or the other. */
    at: { individuality: FinalizedSnapshot; assetHub: FinalizedSnapshot };
    /** Newest award block first. */
    credits: Credit[];
}

/** `NftCredits.NftClaimCreditRoots`, and the same shape `NftClaims.CreditTrees` stores. */
export interface RawCreditRoot {
    game_index: number;
    root: string;
    leaf_count: number;
    timestamp: number;
}

/** One row of `NftCredits.NftClaimCreditAwards`. */
export interface RawCreditAward {
    claimant: { type: "Account" | "Person"; value: string };
    credit: string;
}

/** One entry of a successful `NftCreditsApi.nft_claim_credit_proofs`. */
export interface RawCreditProof {
    credit: string;
    leaf_index: number;
    proof: unknown;
}

/** The runtime `Result` a PAPI runtime API call resolves to. */
export type RuntimeResult<T, E = { type: string }> =
    | { success: true; value: T }
    | { success: false; value: E };

/** Options every pinned storage read is given, so all of them agree on a block. */
export interface ReadAt {
    at: string;
    signal?: AbortSignal;
}

/**
 * How a claim picks the item it mints, from `NftClaims.CollectionMinters`.
 *
 * `Contract` carries a pallet-revive `H160`, `0x`-prefixed. The runtime
 * validates it at registration through `CollectionSelector::validate`, so an
 * address here always had code at the block it was registered in.
 */
export type ItemSelection = { tag: "Random" } | { tag: "Contract"; address: string };

/**
 * A collection registered to accept claims.
 *
 * Driven by `NftClaims.CollectionMinters`, not by `Scarcity.Collections`: a
 * collection with no minter entry cannot be claimed into, so it does not belong
 * in a collection picker even though its catalogue exists.
 */
export interface ClaimableCollection {
    /** The Scarcity collection id. */
    id: number;
    /**
     * The `name` metadata of the collection, or `null` when it sets none.
     *
     * Read from `Scarcity.CollectionMetadata`, not from a runtime API. See the
     * note on {@link CollectionItem.attributes}.
     */
    name: string | null;
    /**
     * Live item definitions in the collection, from `Collections.item_count`.
     *
     * `null` when the collection has a minter entry but no `Scarcity.Collections`
     * record. The runtime clears registrations through
     * `pallet_scarcity::OnCollectionDeleted`, so this should not happen. It is
     * reported rather than papered over so a caller can tell "empty" from
     * "inconsistent".
     */
    itemCount: number | null;
    /**
     * The Scarcity owner of the collection, from `Scarcity.Collections`, or `null`
     * when the record is missing.
     *
     * `CollectionMinters` carries a registering owner of its own; they are the
     * same account today, and this is the authoritative one.
     */
    owner: string | null;
    /** How a claim into this collection picks its item. */
    selection: ItemSelection;
}

/**
 * A collection, claimable or not.
 *
 * The superset {@link ClaimableCollection} is drawn from: every
 * `Scarcity.Collections` record, with `selection` filled in for the ones
 * `NftClaims.CollectionMinters` also names. One deployment carries six
 * collections and registers one, so the difference is not marginal.
 *
 * `itemCount` and `owner` are non-null here, unlike on
 * {@link ClaimableCollection}: this read enumerates the records themselves, so
 * every entry it returns has one. The trade is the mirror image: a minter entry
 * whose collection record is missing appears in
 * {@link ClaimableCollection}-shaped reads and **cannot** appear here.
 */
export interface Collection {
    /** The Scarcity collection id. */
    id: number;
    /** The `name` metadata of the collection, or `null` when it sets none. */
    name: string | null;
    /** Live item definitions, from `Collections.item_count`. */
    itemCount: number;
    /** The Scarcity owner of the collection. */
    owner: string;
    /**
     * How a claim into this collection picks its item, or `null` when the
     * collection accepts no claims.
     *
     * `null` *is* the "not claimable" signal. There is no separate boolean to
     * drift out of sync with it. A collection with no `CollectionMinters` entry
     * cannot be claimed into no matter how many items it holds.
     */
    selection: ItemSelection | null;
}

/**
 * The `image` metadata of an item, read both ways.
 *
 * One deployment stores a 32-byte content digest here, another an ASCII IPFS
 * CID. Nothing declares which, so both readings are reported.
 */
export interface ImageRef {
    /** The raw bytes as `0x`-prefixed hex. Always present. */
    hex: string;
    /** The same bytes as UTF-8, or `null` when they are not readable text. */
    text: string | null;
}

/** One item definition in a collection, with its display metadata merged in. */
export interface CollectionItem {
    /** The item index within its collection. */
    index: number;
    /** Instances the definition may ever mint. */
    supply: number;
    /** Instances currently alive, which is `supply` less those burned. */
    liveSupply: number;
    /** The `name` metadata of the item, or `null` when neither it nor its collection sets one. */
    name: string | null;
    /**
     * The `image` metadata of the item, or `null` when neither it nor its collection
     * sets one.
     *
     * Read as hex and as text both, since deployments disagree about which one
     * they store. Which field to display follows the deployment convention,
     * which is not something this package can read off the chain.
     */
    imageRef: ImageRef | null;
    /** The `rarity` metadata of the item, or `null` when unset. */
    rarity: string | null;
    /**
     * Every metadata key on the item, collection defaults merged underneath, or
     * `null` when the read was not asked for them.
     *
     * **`null` is "not fetched", not "no metadata".** An empty object would claim
     * the item carries no metadata, which is a different statement. Pass
     * `attributes: true` to `getCollectionItems` to fill this in; it costs a
     * prefix scan of the item metadata of the whole collection, because these keys are
     * open and cannot be asked for by name the way `name`, `image` and `rarity`
     * can.
     *
     * **The schema is open.** `Scarcity` stores metadata as untyped
     * `Vec<u8>` keys to `Vec<u8>` values in three layers (`CollectionMetadata`,
     * `ItemMetadata`, `InstanceMetadata`), each overriding the last for the same
     * key. Nothing declares which keys exist or how their values are
     * typed. `name`, `image` and `rarity` are lifted into typed fields because
     * every deployment read so far carries them; the keys around them do not
     * agree. One item carries `palette`, `energy` and `style`, another
     * `description`, which is why the whole bag is exposed rather than a closed
     * shape.
     *
     * Values are decoded as UTF-8 when the bytes are valid printable UTF-8, and
     * as `0x`-hex otherwise. Numbers are **not** parsed, and nothing is lost by
     * that: on the live chain `energy` holds the two ASCII characters `2` and
     * `1`, so the chain stored the text "21" there rather than a binary number.
     * A caller wanting a number parses the string and decides what a malformed
     * one means.
     *
     * `transferability` is absent on purpose. The field appears in earlier
     * `pallet_nfts`-based designs (`CollectionSetting::TransferableItems`) and
     * has no source in `Scarcity`. Neither `ItemDefs` nor any metadata key on
     * the live chain carries it.
     */
    attributes: Record<string, string> | null;
}

/** One page of the item catalogue of a collection. */
export interface CollectionDetail {
    id: number;
    /** The `name` metadata of the collection, or `null` when it sets none. */
    name: string | null;
    /**
     * Live item definitions in the whole collection, from
     * `Collections.item_count`.
     *
     * The size of the catalogue, not of this page. Compare `items.length`. It
     * can also disagree with the stored definitions while one is being removed,
     * since the count and the entries are separate writes; reported as the chain
     * has it rather than recomputed.
     */
    itemCount: number;
    /** The definitions in this page, ascending by index. */
    items: CollectionItem[];
}

/**
 * The answer to "what is in collection N": the catalogue, or a clean miss.
 *
 * A collection nobody created is not a failure. It has no `Scarcity.Collections`
 * record, the chain says so, and that answer travels on the `ok` channel.
 */
export type CollectionItemsResult =
    | {
          tag: "Found";
          at: FinalizedSnapshot;
          /**
           * The exclusive upper bound of the item index space of this collection, from
           * `Collections.next_item_index`.
           *
           * Counts every item ever defined here, since `delete_item` never reuses
           * an index; `collection.itemCount` counts the ones still alive. Named as
           * the listing reads name theirs, and carried at the same depth, so one
           * pager works against any read here.
           */
          idCeiling: number;
          /**
           * The `fromId` a next page should use, or `null` at the end of the index
           * space.
           *
           * The only end signal. A page can be short of `limit` without being
           * the last one.
           */
          nextId: number | null;
          collection: CollectionDetail;
      }
    | { tag: "NotFound"; at: FinalizedSnapshot; id: number };

/** `Scarcity.Collections`, narrowed to the fields these reads use. */
export interface RawCollection {
    owner: string;
    item_count: number;
    /**
     * The exclusive end of the item index space of this collection.
     *
     * Distinct from `item_count`: indices are allocated sequentially and never
     * reused, so this counts every item ever defined while `item_count` counts
     * the live ones. A paged catalogue read walks against this, which is why it
     * needs no extra read to learn where the space ends.
     */
    next_item_index: number;
}

/** `Scarcity.ItemDefs`. */
export interface RawItemDef {
    supply: number;
    live_supply: number;
}

/** `NftClaims.CollectionMinters`. */
export interface RawMinter {
    owner: string;
    selection: { type: string; value?: unknown };
}

/**
 * The value of a metadata entry: the raw bytes, or the PAPI `Binary` wrapper
 * around them.
 *
 * Both are accepted because PAPI ≥2.0 dropped the `Binary` class for some
 * codecs and kept it for others. It is the same reason `verify.ts` in
 * `@parity/product-sdk-cloud-storage` accepts both.
 */
export type RawBytes = Uint8Array | { asBytes(): Uint8Array };

/** `Scarcity.CollectionMetadata` / `ItemMetadata` / `InstanceMetadata`. */
export interface RawMetadataEntry {
    value: RawBytes;
}
