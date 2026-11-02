// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Find a name's `profile` record: the dotNS walk the core makes in
 * `runtime/public_profile.rs` and `text_record` in `product_manifest.rs`,
 * built on the identity module's TLD, namehash and address resolution.
 */
import { createLogger } from "@parity/product-sdk-logger";
import { type Result, err, ok } from "@parity/result";

import { DOTNS_CONTENT_RESOLVER_ABI, DOTNS_REGISTRY_ABI } from "../identity/dotns-abis.js";
import {
    contractOf,
    isZero,
    readOrigin,
    resolveDotNsAddresses,
} from "../identity/dotns-addresses.js";
import { DotNsError } from "../identity/dotns-errors.js";
import { type DotNsTld, namehash, stripSuffix } from "../identity/dotns-namehash.js";
import { type DotNsClientOptions, isRevert, resolveTld } from "../identity/dotns-registry.js";
import { decodeProfileRecord } from "./record.js";
import { PROFILE_TEXT_RECORD_KEY, type PublicProfile } from "./types.js";

const log = createLogger("profile");

type HexString = `0x${string}`;

/**
 * The core's `acceptable_label`: non-empty, at most 64 characters, and every
 * dotted part made of lowercase ASCII letters, digits and hyphens. Looser than
 * the registrar's rule for a registration, on purpose: a lite name such as
 * `alice.42` has a two-character container part the registrar would refuse,
 * and it is a name all the same.
 */
export function isAcceptableProfileLabel(label: string): boolean {
    return (
        label.length > 0 &&
        label.length <= 64 &&
        label.split(".").every((part) => /^[a-z0-9-]+$/.test(part))
    );
}

/** `label` trimmed, lower-cased and without a trailing `.<tld>`, as the core prepares it. */
export function normalizeProfileLabel(label: string, tld: DotNsTld): string {
    return stripSuffix(label.trim().toLowerCase(), tld.suffix);
}

/**
 * Read the public profile under a dotNS name.
 *
 * `label` is the name without its TLD, `alice` or `alice.42`; a trailing
 * `.<tld>` is tolerated. The TLD comes from the chain through `resolveTld`,
 * and the registry and resolver are reached through the identity module's
 * address resolution, so `opts` is what every other dotNS read takes.
 *
 * Three answers, the same three the core gives a host:
 *
 *   - `ok(profile)`: the name has a record. Either of `avatar` and `name` may
 *     still be absent.
 *   - `ok(null)`: the name has no record, or none this reader can read. That
 *     covers a name with no resolver, a name still parked on the reverse
 *     resolver (whose `text` reverts), an empty record, and a record that is
 *     not a profile. A caller clears what it had cached.
 *   - `err`: the chain could not be reached, or a call failed for another
 *     reason. A caller keeps what it has and asks again later.
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
 * else if (result.value === null) clearProfile();
 * else render(result.value);
 * ```
 */
export async function getProfile(
    label: string,
    opts: DotNsClientOptions,
): Promise<Result<PublicProfile | null, DotNsError>> {
    const tldRes = await resolveTld(opts);
    if (!tldRes.ok) return tldRes;
    const tld = tldRes.value;
    const bare = normalizeProfileLabel(label, tld);
    if (!isAcceptableProfileLabel(bare)) {
        return err(new DotNsError("InvalidName", `${JSON.stringify(label)} is not a dotNS name`));
    }
    const node = namehash(`${bare}${tld.suffix}`, tld);

    const addrs = await resolveDotNsAddresses(opts);
    if (!addrs.ok) return addrs;
    const origin = readOrigin(opts);
    log.debug("getProfile", { label: bare, node, registry: addrs.value.registry });

    try {
        const registry = contractOf(opts.runtime, addrs.value.registry, DOTNS_REGISTRY_ABI);
        const resolverRes = await registry.resolver.query(node, { origin });
        if (!resolverRes.success) {
            return err(
                new DotNsError("RegistryCall", "registry.resolver call failed", {
                    cause: resolverRes.value,
                }),
            );
        }
        // No resolver is no record. The core answers `None` here before it asks
        // for any text.
        const resolverAddr = resolverRes.value;
        if (typeof resolverAddr !== "string" || isZero(resolverAddr)) return ok(null);

        const resolver = contractOf(
            opts.runtime,
            resolverAddr as HexString,
            DOTNS_CONTENT_RESOLVER_ABI,
        );
        const textRes = await resolver.text.query(node, PROFILE_TEXT_RECORD_KEY, { origin });
        if (!textRes.success) {
            // A name still parked on the reverse resolver, or on any resolver
            // without text records, reverts. That is a name with no profile,
            // not a failure, and the content resolver is never consulted in
            // its place.
            if (isRevert(textRes.value)) {
                log.debug("resolver has no text records; treating the profile as none", {
                    label: bare,
                    resolver: resolverAddr,
                });
                return ok(null);
            }
            return err(
                new DotNsError("RegistryCall", "resolver.text call failed", {
                    cause: textRes.value,
                }),
            );
        }
        const text = typeof textRes.value === "string" ? textRes.value.trim() : "";
        if (text === "") return ok(null);

        const decoded = decodeProfileRecord(text);
        if (!decoded.ok) {
            // Debug, not warn: the record is the name owner's, not the caller's.
            log.debug("the profile record does not decode; treating it as none", {
                label: bare,
                reason: decoded.error.reason,
            });
            return ok(null);
        }
        return ok(decoded.value);
    } catch (cause) {
        return err(
            new DotNsError("RegistryCall", `profile lookup failed for ${JSON.stringify(bare)}`, {
                cause,
            }),
        );
    }
}
