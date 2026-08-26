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
     * The collection's `name` metadata, or `null` when it sets none.
     *
     * Read from `Scarcity.CollectionMetadata`, not from a runtime API — see the
     * note on {@link CollectionItem.attributes}.
     */
    name: string | null;
    /** How a claim into this collection picks its item. */
    selection: ItemSelection;
    /**
     * Live item definitions in the collection, from `Collections.item_count`.
     *
     * `null` when the collection has a minter entry but no `Scarcity.Collections`
     * record. The runtime clears registrations through
     * `pallet_scarcity::OnCollectionDeleted`, so this should not happen — it is
     * reported rather than papered over so a caller can tell "empty" from
     * "inconsistent".
     */
    itemCount: number | null;
    /**
     * The collection's Scarcity owner, from `Scarcity.Collections`, or `null`
     * when the record is missing.
     *
     * `CollectionMinters` carries a registering owner of its own; they are the
     * same account today, and this is the authoritative one.
     */
    owner: string | null;
}

/**
 * A collection on chain, claimable or not.
 *
 * The superset {@link ClaimableCollection} is drawn from: every
 * `Scarcity.Collections` record, with `selection` filled in for the ones
 * `NftClaims.CollectionMinters` also names. One deployment carries six
 * collections and registers one, so the difference is not marginal.
 *
 * `itemCount` and `owner` are non-null here, unlike on
 * {@link ClaimableCollection}: this read enumerates the records themselves, so
 * every entry it returns has one. The trade is the mirror image — a minter entry
 * whose collection record is missing appears in
 * {@link ClaimableCollection}-shaped reads and **cannot** appear here.
 */
export interface CollectionSummary {
    /** The Scarcity collection id. */
    id: number;
    /** The collection's `name` metadata, or `null` when it sets none. */
    name: string | null;
    /** Live item definitions, from `Collections.item_count`. */
    itemCount: number;
    /** The collection's Scarcity owner. */
    owner: string;
    /**
     * How a claim into this collection picks its item, or `null` when the
     * collection accepts no claims.
     *
     * `null` *is* the "not claimable" signal — there is no separate boolean to
     * drift out of sync with it. A collection with no `CollectionMinters` entry
     * cannot be claimed into no matter how many items it holds.
     */
    selection: ItemSelection | null;
}

/**
 * An item's `image` metadata, read both ways.
 *
 * One deployment stores a 32-byte content digest here, another an ASCII IPFS
 * CID. Nothing on chain declares which, so both readings are reported.
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
    /** Instances currently alive — `supply` less those burned. */
    liveSupply: number;
    /** The item's `name` metadata, or `null` when neither it nor its collection sets one. */
    name: string | null;
    /**
     * The item's `image` metadata, or `null` when neither it nor its collection
     * sets one.
     *
     * Read as hex and as text both, since deployments disagree about which one
     * they store. Which field to display follows the deployment's convention,
     * which is not something this package can read off the chain.
     */
    imageRef: ImageRef | null;
    /** The item's `rarity` metadata, or `null` when unset. */
    rarity: string | null;
    /**
     * Every metadata key on the item, collection defaults merged underneath.
     *
     * **The schema is open.** `Scarcity` stores metadata as untyped
     * `Vec<u8>` → `Vec<u8>` in three layers (`CollectionMetadata`,
     * `ItemMetadata`, `InstanceMetadata`), each overriding the last for the same
     * key. Nothing on chain declares which keys exist or how their values are
     * typed. `name`, `image` and `rarity` are lifted into typed fields because
     * every deployment read so far carries them; the keys around them do not
     * agree — one item carries `palette`, `energy` and `style`, another
     * `description` — which is why the whole bag is exposed rather than a closed
     * shape.
     *
     * Values are decoded as UTF-8 when the bytes are valid printable UTF-8, and
     * as `0x`-hex otherwise. Numbers are **not** parsed: one live item's `energy`
     * is the two bytes `"21"`, text and not a SCALE-encoded integer, so a caller
     * wanting a number parses it and decides what a malformed one means.
     *
     * `transferability` is absent on purpose. The field appears in earlier
     * `pallet_nfts`-based designs (`CollectionSetting::TransferableItems`) and
     * has no source in `Scarcity` — neither `ItemDefs` nor any metadata key on
     * the live chain carries it.
     */
    attributes: Record<string, string>;
}

/** A collection's full item catalogue. */
export interface CollectionDetail {
    id: number;
    /** The collection's `name` metadata, or `null` when it sets none. */
    name: string | null;
    /**
     * Live item definitions, from `Collections.item_count`.
     *
     * Normally `items.length`. It can exceed it while a definition is being
     * removed, since the count and the entries are separate writes — reported as
     * the chain has it rather than recomputed.
     */
    itemCount: number;
    /** The definitions themselves, ascending by index. */
    items: CollectionItem[];
}

/**
 * The answer to "what is in collection N": the catalogue, or a clean miss.
 *
 * A collection nobody created is not a failure. It has no `Scarcity.Collections`
 * record, the chain says so, and that answer travels on the `ok` channel.
 */
export type CollectionItemsResult =
    | { tag: "Found"; at: FinalizedSnapshot; collection: CollectionDetail }
    | { tag: "NotFound"; at: FinalizedSnapshot; id: number };

/** `Scarcity.Collections`, narrowed to the fields these reads use. */
export interface RawCollection {
    owner: string;
    item_count: number;
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
 * A metadata entry's value: the raw bytes, or PAPI's `Binary` wrapper around
 * them.
 *
 * Both are accepted because PAPI ≥2.0 dropped the `Binary` class for some
 * codecs and kept it for others — the same reason
 * `@parity/product-sdk-cloud-storage`'s `verify.ts` accepts both.
 */
export type RawBytes = Uint8Array | { asBytes(): Uint8Array };

/** `Scarcity.CollectionMetadata` / `ItemMetadata` / `InstanceMetadata`. */
export interface RawMetadataEntry {
    value: RawBytes;
}
