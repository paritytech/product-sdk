// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Find a name's `profile` record: the dotNS walk the host core's
 * public-profile reader makes (truapi `public_profile.rs`, not yet on main),
 * built on the identity module's TLD and address
 * resolution.
 */
import { createLogger } from "@parity/product-sdk-logger";
import { type Result, err, ok } from "@parity/result";

import { DOTNS_CONTENT_RESOLVER_ABI } from "../identity/dotns-abis.js";
import {
    contractOf,
    readOrigin,
    resolveDotNsContentResolver,
} from "../identity/dotns-addresses.js";
import { DotNsError } from "../identity/dotns-errors.js";
import { type DotNsTld, namehash, stripSuffix } from "../identity/dotns-namehash.js";
import { type DotNsClientOptions, resolveTld } from "../identity/dotns-registry.js";
import { decodeProfileRecord } from "./record.js";
import { PROFILE_TEXT_RECORD_KEY, type ProfileLookup } from "./types.js";

const log = createLogger("profile");

type HexString = `0x${string}`;

const NO_PROFILE: ProfileLookup = { tag: "NoProfile" };

/** `MAX_DNS_LABEL_LEN` in the core: the longest DNS label. */
const MAX_DNS_LABEL_LEN = 63;
/** `MAX_BASE_LABEL_LEN` in the core: the longest base label the gateway pallet holds. */
const MAX_BASE_LABEL_LEN = 32;

/** The core's `is_dns_label`: one lowercase label with no edge hyphen. */
function isDnsLabel(value: string): boolean {
    return (
        value.length > 0 &&
        value.length <= MAX_DNS_LABEL_LEN &&
        !value.startsWith("-") &&
        !value.endsWith("-") &&
        /^[a-z0-9-]+$/.test(value)
    );
}

/**
 * The core's `is_dotted_lite_username`: a lite name such as `alice.01`, a stem
 * of lowercase letters and exactly two digits after one dot, at most 32 bytes
 * in all, since the gateway pallet keys `LiteLabelOwner` by the dotted label.
 */
function isDottedLiteUsername(value: string): boolean {
    const dot = value.lastIndexOf(".");
    if (dot < 0) return false;
    const stem = value.slice(0, dot);
    const digits = value.slice(dot + 1);
    return (
        stem.length > 0 &&
        /^[a-z]+$/.test(stem) &&
        /^[0-9]{2}$/.test(digits) &&
        value.length <= MAX_BASE_LABEL_LEN
    );
}

/**
 * The usernames the core resolves a profile for, `validate_username` in
 * `public_profile.rs`: a DNS label, or a dotted lite username. The same forms
 * the identity reader returns, and nothing looser: `alice.1` is not a lite name.
 */
export function isAcceptableProfileLabel(label: string): boolean {
    return isDnsLabel(label) || isDottedLiteUsername(label);
}

/** `label` trimmed, lower-cased and without a trailing `.<tld>`, as the core prepares it. */
export function normalizeProfileLabel(label: string, tld: DotNsTld): string {
    return stripSuffix(label.trim().toLowerCase(), tld.suffix);
}

/** Where a name's `profile` record lives: the name, plus the deployment's content resolver. */
export type ProfileLocation = ProfileName & {
    /** `null` for a deployment with none, which holds no profiles. */
    contentResolver: HexString | null;
};

/**
 * The node and the content resolver for `label`: the dotNS walk every profile
 * read and write starts with.
 *
 * `label` is the name without its TLD, `alice` or `alice.01`; a trailing
 * `.<tld>` is tolerated. The TLD comes from the chain through `resolveTld`,
 * and the content resolver through `resolveDotNsContentResolver`, so `opts` is
 * what every other dotNS read takes.
 *
 * The record lives on the deployment's content resolver, whatever resolver the
 * name itself points at. Every name is minted pointing at the reverse
 * resolver, and its profile is on the content resolver all the same; the
 * core's public-profile reader reads and writes it there, and so does this
 * module.
 */
export async function locateProfile(
    label: string,
    opts: DotNsClientOptions,
): Promise<Result<ProfileLocation, DotNsError>> {
    // The name first, so a label that is not a name makes no call at all.
    const name = await resolveProfileName(label, opts);
    if (!name.ok) return name;
    const resolverRes = await resolveDotNsContentResolver(opts);
    if (!resolverRes.ok) return resolverRes;
    return ok({ ...name.value, contentResolver: resolverRes.value });
}

/** A label resolved against the network's TLD. */
export interface ProfileName {
    /** The label as the registry keys it: trimmed, lower-cased, without the TLD. */
    bare: string;
    tld: DotNsTld;
    /** The namehash of `<bare>.<tld>`, with a lite name's parts as levels. */
    node: HexString;
}

/**
 * The first half of {@link locateProfile}: the TLD from the chain, the label
 * normalised and checked, and the node. What every function that takes a
 * label starts from, whether or not it goes on to the content resolver.
 */
export async function resolveProfileName(
    label: string,
    opts: DotNsClientOptions,
): Promise<Result<ProfileName, DotNsError>> {
    const tldRes = await resolveTld(opts);
    if (!tldRes.ok) return tldRes;
    const tld = tldRes.value;
    const bare = normalizeProfileLabel(label, tld);
    if (!isAcceptableProfileLabel(bare)) {
        return err(new DotNsError("InvalidName", `${JSON.stringify(label)} is not a dotNS name`));
    }
    return ok({ bare, tld, node: namehash(`${bare}${tld.suffix}`, tld) });
}

/**
 * The raw `profile` text the content resolver holds for `node`, trimmed, `""`
 * for none. The value as written, so a writer can refuse a malformed record
 * without losing it and a verifier can compare bytes.
 */
export async function readProfileText(
    contentResolver: HexString,
    node: HexString,
    opts: DotNsClientOptions,
): Promise<Result<string, DotNsError>> {
    const origin = readOrigin(opts);
    try {
        const resolver = contractOf(opts.runtime, contentResolver, DOTNS_CONTENT_RESOLVER_ABI);
        const textRes = await resolver.text.query(node, PROFILE_TEXT_RECORD_KEY, { origin });
        if (!textRes.success) {
            return err(
                new DotNsError("RegistryCall", "contentResolver.text call failed", {
                    cause: textRes.value,
                }),
            );
        }
        return ok(typeof textRes.value === "string" ? textRes.value.trim() : "");
    } catch (cause) {
        return err(new DotNsError("RegistryCall", "contentResolver.text read failed", { cause }));
    }
}

/**
 * Read the public profile under a dotNS name. See {@link locateProfile} for
 * what `label` and `opts` are and where the record is read from.
 *
 * Three answers, the same three the core gives a host:
 *
 *   - `ok({ tag: "Found", profile })`: the name has a record. Either of
 *     `avatar` and `name` may still be absent.
 *   - `ok({ tag: "NoProfile" })`: the name has no record, or none this reader
 *     can read. That covers a deployment with no content resolver, an empty
 *     record, and a record that is not a profile, which includes one written
 *     in the layout that preceded the RFC. Not a failure: a caller clears what
 *     it had cached.
 *   - `err`: the chain could not be reached, or a call failed for another
 *     reason, a `text` call that reverts included. A caller keeps what it has
 *     and asks again later.
 *
 * Every read is a contract view call through the host-routed chain client,
 * pinned to the best block as the runtime's dry-runs are. Nothing is cached:
 * the record changes rarely and a product decides its own refresh cadence,
 * using `avatar.cid` to skip a fetch of bytes it already holds.
 *
 * @example
 * ```ts
 * const runtime = createContractRuntimeFromClient(chain.raw.assetHub, paseo_asset_hub);
 * const result = await getProfile("alice", { runtime });
 * if (!result.ok) showStale();
 * else if (result.value.tag === "NoProfile") clearProfile();
 * else render(result.value.profile);
 * ```
 */
export async function getProfile(
    label: string,
    opts: DotNsClientOptions,
): Promise<Result<ProfileLookup, DotNsError>> {
    const text = await getProfileRecord(label, opts);
    if (!text.ok) return text;
    if (text.value === "") return ok(NO_PROFILE);

    const decoded = decodeProfileRecord(text.value);
    if (!decoded.ok) {
        // Debug, not warn: the record is the name owner's, not the caller's.
        log.debug("the profile record does not decode; treating it as none", {
            label,
            reason: decoded.error.reason,
        });
        return ok(NO_PROFILE);
    }
    return ok({ tag: "Found", profile: decoded.value });
}

/**
 * The `profile` record of `label` as the content resolver holds it, trimmed,
 * `""` for none. The text a write starts from: `rewriteProfileRecord` takes
 * it as `live`, and it is what to read again before submitting a prepared
 * write. A deployment with no content resolver holds nothing, so answers
 * `""`. For the decoded profile, use `getProfile`.
 */
export async function getProfileRecord(
    label: string,
    opts: DotNsClientOptions,
): Promise<Result<string, DotNsError>> {
    const located = await locateProfile(label, opts);
    if (!located.ok) return located;
    const { bare, node, contentResolver } = located.value;
    // A deployment with no content resolver has no text records.
    if (contentResolver === null) return ok("");
    log.debug("profile record", { label: bare, node, resolver: contentResolver });
    return readProfileText(contentResolver, node, opts);
}

/**
 * Whether the content resolver now holds exactly `text` for `label`: the
 * check a publisher makes once its write is final, as the core's does, so a
 * write the chain included but did not apply, or one overtaken by another
 * writer, is not reported as published. `""` asks whether the record is
 * cleared.
 */
export async function verifyPublishedProfile(
    label: string,
    text: string,
    opts: DotNsClientOptions,
): Promise<Result<boolean, DotNsError>> {
    const stored = await getProfileRecord(label, opts);
    if (!stored.ok) return stored;
    return ok(stored.value === text.trim());
}
