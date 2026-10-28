// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The shapes of a public profile, mirroring `truapi::v01::profile` in the host
 * core (`rust/crates/truapi/src/v01/profile.rs`), which is the source of truth.
 * The names are kept so a later truapi-generated binding reads the same.
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

/** Entry kind of a {@link ProfileAvatar}. */
export const PROFILE_ENTRY_AVATAR = "avatar";
/** Entry kind of the display name: the raw UTF-8 bytes, no inner length prefix. */
export const PROFILE_ENTRY_NAME = "name";
/** Entry kind of a {@link ProfileNft}. */
export const PROFILE_ENTRY_NFT = "nft";
/** Entry kind of a {@link ProfileFeed}. */
export const PROFILE_ENTRY_FEED = "feed";

/**
 * The formats an avatar may be in. The index is what travels: `png` is 0,
 * `jpeg` is 1, `webp` is 2, as `ProfileAvatarFormat` in the core numbers them.
 */
export const PROFILE_AVATAR_FORMATS = ["png", "jpeg", "webp"] as const;
export type ProfileAvatarFormat = (typeof PROFILE_AVATAR_FORMATS)[number];

/** One element of a {@link ProfileRecord}. */
export interface ProfileEntry {
    /** `avatar`, `name`, `nft`, `feed`, or a kind this reader keeps and does not read. */
    kind: string;
    /** The kind's payload: SCALE for a tuple kind, bare bytes for `name`. */
    payload: Uint8Array;
}

/** A person's public profile as published under their dotNS name, before any entry is read. */
export interface ProfileRecord {
    /** In the owner's order; a kind may repeat. */
    entries: ProfileEntry[];
}

/** Payload of an `avatar` entry. */
export interface ProfileAvatar {
    /** Bulletin CID of the image bytes, raw codec, blake2b-256. */
    cid: string;
    /** The image format, declared so no reader sniffs bytes. */
    format: ProfileAvatarFormat;
}

/**
 * Payload of an `nft` entry: one pinned item and the purse that should hold
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

/** Payload of a `feed` entry: a statement-store feed the profile points at. */
export interface ProfileFeed {
    /** The feed kind, such as `mood`. Not interpreted here. */
    kind: string;
    /** The statement topic every statement of the feed carries, 32 bytes as `0x` hex. */
    topic: `0x${string}`;
    /** The account whose proof a statement must carry to count, 32 bytes as `0x` hex. */
    signer: `0x${string}`;
}

/**
 * What a reader gets from a record: the kinds it knows, read by the core's
 * rules, and the rest untouched.
 *
 * `avatar` and `name` are the first valid entry of their kind, as
 * `ProfileRecord::avatar` and `ProfileRecord::name` answer in the core. `nfts`
 * and `feeds` are every entry of their kind that decodes, in the owner's
 * order. `unknown` keeps every entry of a kind this reader does not know.
 */
export interface PublicProfile {
    avatar: ProfileAvatar | null;
    name: string | null;
    nfts: ProfileNft[];
    feeds: ProfileFeed[];
    unknown: ProfileEntry[];
}

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
