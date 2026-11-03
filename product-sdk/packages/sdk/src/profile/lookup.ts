// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Find a name's `profile` record: the dotNS walk the host core makes in
 * `public_profile.rs`, built on the identity module's TLD and address
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
        stem.length <= MAX_DNS_LABEL_LEN &&
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

/**
 * Read the public profile under a dotNS name.
 *
 * `label` is the name without its TLD, `alice` or `alice.01`; a trailing
 * `.<tld>` is tolerated. The TLD comes from the chain through `resolveTld`,
 * and the content resolver through `resolveDotNsContentResolver`, so `opts` is
 * what every other dotNS read takes.
 *
 * The record is read from the deployment's content resolver, whatever resolver
 * the name itself points at. A name minted through the gateway stays parked on
 * the reverse resolver, and its profile is on the content resolver all the
 * same; the core reads it there, and so does this.
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
    const tldRes = await resolveTld(opts);
    if (!tldRes.ok) return tldRes;
    const tld = tldRes.value;
    const bare = normalizeProfileLabel(label, tld);
    if (!isAcceptableProfileLabel(bare)) {
        return err(new DotNsError("InvalidName", `${JSON.stringify(label)} is not a dotNS name`));
    }
    const node = namehash(`${bare}${tld.suffix}`, tld);

    const resolverRes = await resolveDotNsContentResolver(opts);
    if (!resolverRes.ok) return resolverRes;
    // A deployment with no content resolver has no text records, so no profile.
    if (resolverRes.value === null) return ok(NO_PROFILE);
    const origin = readOrigin(opts);
    log.debug("getProfile", { label: bare, node, resolver: resolverRes.value });

    try {
        const resolver = contractOf(opts.runtime, resolverRes.value, DOTNS_CONTENT_RESOLVER_ABI);
        const textRes = await resolver.text.query(node, PROFILE_TEXT_RECORD_KEY, { origin });
        if (!textRes.success) {
            return err(
                new DotNsError("RegistryCall", "contentResolver.text call failed", {
                    cause: textRes.value,
                }),
            );
        }
        const text = typeof textRes.value === "string" ? textRes.value.trim() : "";
        if (text === "") return ok(NO_PROFILE);

        const decoded = decodeProfileRecord(text);
        if (!decoded.ok) {
            // Debug, not warn: the record is the name owner's, not the caller's.
            log.debug("the profile record does not decode; treating it as none", {
                label: bare,
                reason: decoded.error.reason,
            });
            return ok(NO_PROFILE);
        }
        return ok({ tag: "Found", profile: decoded.value });
    } catch (cause) {
        return err(
            new DotNsError("RegistryCall", `profile lookup failed for ${JSON.stringify(bare)}`, {
                cause,
            }),
        );
    }
}
