// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The shapes of a public profile.
 *
 * The envelope and the `Avatar` entry are fixed by the RFC "Core-resolved
 * public profiles" in host-rust-core (`docs/rfcs/core-resolved-public-profiles.md`),
 * whose Rust types the core decodes with. The other entry kinds are proposed
 * here; {@link PROFILE_ENTRY_INDEX} holds the table and the claiming rule. The
 * names are kept as the RFC spells them so a later truapi-generated binding
 * reads the same.
 */
import type {
    FinalizedSnapshot,
    InstanceDisplay,
    NftsInstancesChain,
    ReadAt,
} from "@parity/product-sdk-nfts";

/** The dotNS text-record key a public profile lives under. */
export const PROFILE_TEXT_RECORD_KEY = "profile";

/** Reader-side bound: a decoded record larger than this is not a profile. */
export const PROFILE_RECORD_MAX_BYTES = 16 * 1024;

/** A display name is at most this many UTF-8 bytes. */
export const PROFILE_NAME_MAX_BYTES = 64;

/** Reader-side bound: avatar bytes over this are refused before they are checked against the CID. */
export const PROFILE_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The `ProfileEntry` variant indices: the byte that starts every entry.
 *
 * | Index | Entry    | Payload                                                          | Status                                      |
 * |-------|----------|------------------------------------------------------------------|---------------------------------------------|
 * | 0     | `Avatar` | `{ cid: String, format: u8 }`, the format indexing `PROFILE_AVATAR_FORMATS` | accepted, RFC core-resolved-public-profiles |
 * | 1     | `Name`   | `String`: the display name, at most `PROFILE_NAME_MAX_BYTES` of UTF-8 | proposed 2026-10-30, written by Seity since |
 * | 2     | `Nft`    | `{ instance: u64, collection: u32, item: u32, purse: [u8; 32] }` | proposed 2026-10-30, written by Seity since |
 * | 3     | `Feed`   | `{ kind: String, topic: [u8; 32], signer: [u8; 32] }`            | proposed 2026-10-30, written by Seity since |
 *
 * This table is where the next index is proposed. An index is claimed by the
 * PR that adds it here, with its payload, its reader rule and a pinned test
 * vector in `record.test.ts`, and that PR's changeset names the claim. An
 * index is never reused, and a payload never changes once a writer has
 * published it. The RFC is amended when the core starts resolving a kind;
 * until then the core keeps the entry as opaque bytes, which is what makes
 * claiming here safe.
 *
 * Reader rules shared by every kind: the first `Avatar` that decodes is the
 * avatar; the first non-empty `Name` of at most 64 bytes is the name, and an
 * empty or longer one is a known entry this reader ignores; every `Nft` and
 * `Feed` that decodes is kept in the owner's order. An entry whose index is
 * unknown, or whose payload is not exactly one value of the kind its index
 * names, is kept as an {@link UnknownEntry}.
 */
export const PROFILE_ENTRY_INDEX = { avatar: 0, name: 1, nft: 2, feed: 3 } as const;

export type ProfileEntryName = keyof typeof PROFILE_ENTRY_INDEX;

/**
 * The formats an avatar may be in. The index is what travels: `png` is 0,
 * `jpeg` is 1, `webp` is 2, as `ProfileAvatarFormat` in the RFC numbers them.
 */
export const PROFILE_AVATAR_FORMATS = ["png", "jpeg", "webp"] as const;
export type ProfileAvatarFormat = (typeof PROFILE_AVATAR_FORMATS)[number];

/**
 * An entry this reader kept as read: the entry's bytes, index byte first,
 * without the outer length prefix. The RFC's `WrapperKeepOpaque`: an index
 * this reader does not know, or a payload that is not exactly one value of the
 * kind its index names. A writer puts it back unchanged, so a kind added later
 * survives an older editor.
 */
export interface UnknownEntry {
    bytes: Uint8Array;
}

/** Payload of an `Avatar` entry. */
export interface ProfileAvatar {
    /** Bulletin CID of the image bytes, raw codec, blake2b-256. */
    cid: string;
    /** The image format, declared so no reader sniffs bytes. */
    format: ProfileAvatarFormat;
}

/**
 * Payload of an `Nft` entry: one pinned item and the purse that should hold
 * it. The chain, not the record, says whether it is still there.
 */
export interface ProfileNft {
    /** Scarcity's permanent instance id. */
    instance: bigint;
    /** Fixed at mint, so a reader can draw catalogue artwork before the instance is readable. */
    collection: number;
    /** Fixed at mint, as `collection`. */
    item: number;
    /** The account that should hold the item, 32 bytes as `0x` hex. */
    purse: `0x${string}`;
}

/** Payload of a `Feed` entry: a statement-store feed the profile points at. */
export interface ProfileFeed {
    /** The feed kind, such as `mood`. Not interpreted here. */
    kind: string;
    /** The statement topic every statement of the feed carries, 32 bytes as `0x` hex. */
    topic: `0x${string}`;
    /** The account whose proof a statement must carry to count, 32 bytes as `0x` hex. */
    signer: `0x${string}`;
}

/**
 * What a reader gets from a record: the kinds it knows, read by the rules in
 * {@link PROFILE_ENTRY_INDEX}, and the rest untouched.
 *
 * `avatar` and `name` are the first valid entry of their kind. `nfts` and
 * `feeds` are every entry of their kind that decodes, in the owner's order.
 * `unknown` keeps every entry this reader could not read.
 */
export interface PublicProfile {
    avatar: ProfileAvatar | null;
    name: string | null;
    nfts: ProfileNft[];
    feeds: ProfileFeed[];
    unknown: UnknownEntry[];
}

/**
 * What one write changes. A field left `undefined` keeps every live entry of
 * that kind; `null` clears the kind. `nfts` replaces every pin, since the pins
 * are one list. `feeds` replaces only the kinds it names, so a mood feed can
 * be set without touching a feed of another kind; `null` clears them all.
 */
export interface ProfilePatch {
    avatar?: ProfileAvatar | null;
    /** `null` clears. An empty string is refused, so there is no third meaning. */
    name?: string | null;
    nfts?: ProfileNft[] | null;
    feeds?: ProfileFeed[] | null;
}

/**
 * What `getProfile` answers on the `ok` channel. `NoProfile` is a name with no
 * record, or none this reader can read; it is not a failure, so a caller
 * clears what it had cached. A chain that could not be asked is on the `err`
 * channel, and a caller keeps what it has.
 */
export type ProfileLookup = { tag: "Found"; profile: PublicProfile } | { tag: "NoProfile" };

/** The MIME type an avatar's declared format maps to. Never sniffed from the bytes. */
export type AvatarMimeType = "image/png" | "image/jpeg" | "image/webp";

/** An avatar fetched through the host and checked against its CID. */
export interface LoadedAvatar {
    /** For change detection: a product that keeps bytes by CID can skip the next fetch. */
    cid: string;
    format: ProfileAvatarFormat;
    mimeType: AvatarMimeType;
    /** The image bytes, which hash to `cid`. */
    bytes: Uint8Array;
}

/** A pin the chain confirmed: the purse holds the instance, and it is what the pin says it is. */
export interface PinnedNft {
    nft: ProfileNft;
    display: Extract<InstanceDisplay, { tag: "Found" }>;
}

/**
 * Why a pin was dropped. `NotFound` is an instance the chain does not have,
 * burned or never minted. `Moved` is an instance held by an account other than
 * the pin's purse. `Mismatch` is an instance that exists but was minted from a
 * different collection or item than the pin claims.
 */
export type DroppedPinReason = "NotFound" | "Moved" | "Mismatch";

/** A pin the chain did not confirm, and why. */
export interface DroppedPin {
    nft: ProfileNft;
    reason: DroppedPinReason;
}

/** What one `getPinnedNfts` call returns. Every value was read at `at`. */
export interface PinnedNftsResult {
    at: FinalizedSnapshot;
    /** The confirmed pins, in the record's order. */
    pins: PinnedNft[];
    /** The pins the chain did not confirm, in the record's order. */
    dropped: DroppedPin[];
}

/**
 * The chain a pin check needs: everything `getInstanceDisplays` reads, plus
 * `Scarcity.Instances`, the instance to current owner index the nfts package
 * does not read. A `ChainClient<{ assetHub: paseo_asset_hub }>` satisfies it.
 */
export interface ProfileNftsChain {
    assetHub: NftsInstancesChain["assetHub"] & {
        query: {
            Scarcity: {
                /** `Scarcity.Instances`: instance id → the SS58 account that holds it now. */
                Instances: {
                    getValues(
                        keys: Array<[bigint]>,
                        options: ReadAt,
                    ): Promise<Array<string | undefined>>;
                };
            };
        };
    };
    raw: NftsInstancesChain["raw"];
}
