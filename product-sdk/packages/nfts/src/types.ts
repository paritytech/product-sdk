// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The shapes these reads return, and the raw storage shapes they are built from.
 */

/** A block a read was pinned to. */
export interface BlockSnapshot {
    blockHash: string;
    blockNumber: number;
}

/** The block every value in one result was read at, the latest finalized one unless the caller passed one. */
export type FinalizedSnapshot = BlockSnapshot;

/**
 * The block a read addresses, as PAPI's `at` does: `"finalized"`, the default,
 * `"best"`, or a snapshot another read already pinned.
 */
export type BlockAt = "finalized" | "best" | BlockSnapshot;

/**
 * What every paged read here accepts besides its own window: the block to read
 * at, and the signal that stops it.
 */
export interface PinnedReadOptions {
    /**
     * The block to read at, as PAPI's `at`: `"finalized"`, the default, `"best"`,
     * or a block a previous read already pinned.
     *
     * Pass a snapshot straight from the `at` of another result. Without one
     * every call pins its own block, which is right for unrelated
     * questions and wrong for one question asked in pages: a walk over its own
     * snapshots is not a walk of any single chain state. It is also how two reads
     * are made to agree, the registry and the full list at one block.
     *
     * The node must still have the block pinned, and a walk can outlive that. A
     * page that fails on the `err` channel mid-walk is not the end of the walk:
     * drop `at`, read again from the last `nextId`, and continue on the new
     * snapshot. The examples on each read show the shape.
     */
    at?: BlockAt;
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
 * awards of the block are gone, pruned or expired, so the block counted but this
 * read cannot say how many credits it held or produce the leaf a claim needs.
 *
 * An `earned` entry with a `null` hash is a block still to come: awarding spills
 * into later blocks, and the credits are not known until that block is built.
 */
export type ClaimState = "earned" | "claimable" | "claimed" | "unprovable";

/** One NFT claim credit, as the People chain awarded it and Asset Hub sees it. */
export interface Claim {
    /**
     * The credit hash, `0x` prefixed, as `NftClaimCreditAwards` stores it, or
     * `null` when the awards of its block are gone and the hash with them. A
     * `null` entry stands for a whole block, whose credit count is unknown.
     */
    hash: string | null;
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
    /**
     * The Merkle proof a mint spends, sibling hashes from the leaf up to the
     * root, lowercase and `0x` prefixed. `null` for a claim whose block has no
     * root yet and for an unprovable one, since neither has a proof to spend.
     */
    proof: string[] | null;
    state: ClaimState;
}

/** What one `getClaims` call returns. */
export interface ClaimsResult {
    /** Two chains, so two pinned blocks. Every value came from one or the other. */
    at: { individuality: FinalizedSnapshot; assetHub: FinalizedSnapshot };
    /** Newest award block first. */
    claims: Claim[];
}

/**
 * What claiming one credit into one collection would mint.
 *
 * `preview_mints` runs the real claim selector, so for a `Random` collection
 * this is the item the claim will produce, and switching collection is the only
 * way to change it. A `Contract` collection asks its contract, which can fail,
 * and that failure is an outcome here rather than an error: the chain was asked
 * and answered.
 */
export interface MintPreview {
    collection: number;
    outcome:
        | {
              tag: "Mints";
              item: number;
              via: ItemSelection;
              /** The `name` metadata of the item, collection defaults inherited, or `null`. */
              name: string | null;
              /** The `rarity` metadata of the item, collection defaults inherited, or `null`. */
              rarity: string | null;
              /** The `image` metadata of the item, read both ways, or `null`. */
              imageRef: ImageRef | null;
          }
        | { tag: "Fails"; reason: string };
}

/** What one `previewClaim` call returns. */
export interface MintPreviewResult {
    at: FinalizedSnapshot;
    /** One per collection asked for, in the order asked. */
    previews: MintPreview[];
}

/** One `NftClaimsApi.preview_mints` outcome, positionally matched to its query. */
export type RawMintOutcome =
    | { type: "Mints"; value: { item: number; via: { type: string; value?: unknown } } }
    | { type: "Fails"; value: { reason: { type: string; value?: unknown } } };

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
    /** The sibling hashes from the leaf up to the root, `0x` prefixed. */
    proof: string[];
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
    /** Whether a minted instance can be sent on. A `Soulbound` one stays with its first owner. */
    transferability: Transferability;
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

/**
 * The display metadata of one minted NFT, or a clean miss.
 *
 * An instance nobody minted, or one already burned, is not a failure: the
 * runtime was asked and answered that there is nothing under that id, and the
 * answer travels inside the `ok` payload. The signal is `metadata_batch`
 * declining to resolve the query, not an empty bag — a freshly claim-minted
 * instance carries no metadata at all on the live chain, and it is still
 * `Found`. That distinction is the reason this is a tagged shape rather than a
 * bag that is empty two different ways.
 */
export type InstanceDisplay =
    | {
          tag: "Found";
          /** The instance id asked about. */
          instance: bigint;
          /** The collection the instance was minted from, as the runtime resolved it. */
          collection: number;
          /** The item definition the instance was minted from, within its collection. */
          item: number;
          /**
           * Whether this instance can be sent on, from its item definition.
           *
           * A `Soulbound` one stays with its first owner, so a UI offering to
           * send it is offering a transaction the runtime will reject. Read
           * always rather than behind an option, unlike
           * {@link CollectionItem.attributes}: the key is the
           * `(collection, item)` the instance already resolved to, so it costs
           * one serial hop and no bytes beyond the instances asked about.
           *
           * `null` means the item definition is **gone** from the chain while
           * the instance survives — a real state, not "not fetched". The three
           * definition-backed fields are `null` together.
           */
          transferability: Transferability | null;
          /** Instances the definition may ever mint, or `null` when it is gone. */
          supply: number | null;
          /** Instances currently alive, which is `supply` less those burned, or `null`. */
          liveSupply: number | null;
          /** The `name` metadata, most specific layer winning, or `null` when no layer sets one. */
          name: string | null;
          /** The `image` metadata, read both ways, or `null`. See {@link CollectionItem.imageRef}. */
          imageRef: ImageRef | null;
          /** The `rarity` metadata, most specific layer winning, or `null` when unset. */
          rarity: string | null;
          /**
           * Every metadata key across all three layers, the most specific layer
           * winning per key: instance over item over collection, mirroring the
           * pallet's own `instance_metadata_of`.
           *
           * Always present, unlike {@link CollectionItem.attributes}, and empty
           * when the instance genuinely carries no metadata. The asymmetry is
           * honest: a catalogue page pays a prefix scan for the open bag, so it
           * is opt-in there, while `metadata_batch` returns whole layers whether
           * or not anyone wants them, so withholding them here would save
           * nothing.
           *
           * The schema is open and the values are decoded text-or-hex; the notes
           * on {@link CollectionItem.attributes} apply unchanged. Deployment
           * conventions beyond `name`, `image` and `rarity` — an identity
           * `hash`, a `manifest` CID — live in this bag for the caller to lift.
           */
          attributes: Record<string, string>;
      }
    | { tag: "NotFound"; instance: bigint };

/** What one `getInstanceDisplays` call returns. */
export interface InstanceDisplaysResult {
    at: FinalizedSnapshot;
    /** One per instance asked for, in the order asked. */
    displays: InstanceDisplay[];
}

/** What one `getInstanceDisplay` call returns. */
export interface InstanceDisplayResult {
    at: FinalizedSnapshot;
    display: InstanceDisplay;
}

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
    transferability: { type: Transferability };
}

/** Whether a minted instance of an item can be sent on, from `ItemDefs.transferability`. */
export type Transferability = "Transferable" | "Soulbound";

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

/**
 * One `ScarcityApi.metadata_batch` query: a minted instance, an item
 * definition, or a bare collection.
 *
 * `getInstanceDisplays` only ever sends `Instance` queries; the other two
 * variants are typed because the runtime takes them, so a future read of
 * pre-mint metadata composes on the same entry rather than growing a second
 * contract.
 */
export type RawMetadataQuery =
    | { type: "Instance"; value: bigint }
    | { type: "Item"; value: { collection: number; item: number } }
    | { type: "Collection"; value: number };

/**
 * What `metadata_batch` resolved one query to, when its target exists.
 *
 * For an `Instance` query this is where the instance → (collection, item)
 * mapping comes back: the runtime walks it to assemble the layers anyway, so
 * the caller is told rather than left to re-derive it from owner-keyed storage.
 */
export type RawMetadataTarget =
    | { type: "Instance"; value: { instance: bigint; collection: number; item: number } }
    | { type: "Item"; value: { collection: number; item: number } }
    | { type: "Collection"; value: number };

/**
 * One `metadata_batch` answer, positionally matched to its query.
 *
 * `resolved` is absent exactly when the target does not exist at the block
 * asked: the runtime cannot name the collection and item of an instance nobody
 * minted. The layers of a missing target are empty, but empty layers alone do
 * not mean missing — a claim-minted instance has a `resolved` and no metadata.
 *
 * Each layer is `[key, value]` byte pairs. For an `Instance` query all three
 * layers arrive; for an `Item` query the `instance` layer is empty, and for a
 * `Collection` query the `item` layer is too.
 */
export interface RawMetadataLayers {
    resolved?: RawMetadataTarget | undefined;
    collection: RawBytes[][];
    item: RawBytes[][];
    instance: RawBytes[][];
}
