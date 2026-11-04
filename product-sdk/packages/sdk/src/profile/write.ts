// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Prepare the one call that publishes a `profile` record: the owner's
 * `setText` on the deployment's content resolver, as the core's publisher
 * builds it. Signer-free, like every dotNS write in the identity module: the
 * product submits the prepared call with its own signer, after mapping and
 * funding the account, which the SDK does not do for it.
 */
import { ss58ToH160 } from "@parity/product-sdk-address";
import type { BatchableCall } from "@parity/product-sdk-tx";
import { type Result, err, ok } from "@parity/result";

import { DOTNS_CONTENT_RESOLVER_WRITE_ABI, DOTNS_REGISTRY_ABI } from "../identity/dotns-abis.js";
import { contractOf, resolveDotNsAddresses } from "../identity/dotns-addresses.js";
import { DotNsError } from "../identity/dotns-errors.js";
import type { DotNsClientOptions } from "../identity/dotns-registry.js";
import type { ProfileError } from "./errors.js";
import { locateProfile, readProfileText } from "./lookup.js";
import { decodeRecordEntries } from "./record.js";
import { PROFILE_TEXT_RECORD_KEY } from "./types.js";

/** A `setText` call ready to submit, with what the resolver held when it was prepared. */
export interface PreparedProfileWrite {
    /** Submit with the owner's signer, through `submitAndWatch` or `batchSubmitAndWatch`. */
    call: BatchableCall;
    /** The text the call stores, trimmed. `""` clears the record. */
    text: string;
    /**
     * The text the resolver held when this was prepared, `""` for none. Read
     * it again before submitting, with `verifyPublishedProfile`, and stop if
     * it changed: another writer's record would otherwise be overwritten by
     * one rewritten from this.
     */
    original: string;
}

/**
 * Prepare the call that stores `text` as the `profile` record of `label`.
 *
 * `text` is what `rewriteProfileRecord` produced, or `""` to clear the record.
 * It is checked to be a record readers accept before anything is asked of the
 * chain, so a value no reader decodes is never published.
 *
 * `opts.origin` is required and must be authorised for the name in the
 * registry: its owner, or an address or operator the owner approved, the
 * same rule the content resolver's `setText` enforces. Anyone else fails as
 * `Unauthorised` before the dry-run rather than as a revert. The node's
 * resolver pointer is left alone: `setText` does not consult it, and every
 * reader that matters finds the record on the content resolver without it.
 *
 * The call is sized by a dry-run as the origin, which needs the origin's
 * account mapped in pallet-revive; `ensureContractAccountMapped` from
 * `@parity/product-sdk-contracts` does that once, before this is called.
 */
export async function prepareSetProfile(
    label: string,
    text: string,
    opts: DotNsClientOptions,
): Promise<Result<PreparedProfileWrite, DotNsError | ProfileError>> {
    const value = text.trim();
    if (value !== "") {
        const readable = decodeRecordEntries(value);
        if (!readable.ok) return readable;
    }
    const origin = opts.origin;
    if (!origin) {
        return err(new DotNsError("MissingOrigin", "prepareSetProfile needs opts.origin (SS58)"));
    }
    let self: `0x${string}`;
    try {
        self = ss58ToH160(origin);
    } catch (cause) {
        return err(
            new DotNsError("InvalidOrigin", "opts.origin is not an SS58 address", { cause }),
        );
    }

    const located = await locateProfile(label, opts);
    if (!located.ok) return located;
    const { node, contentResolver } = located.value;
    if (contentResolver === null) {
        return err(
            new DotNsError(
                "AddressDiscovery",
                "the deployment has no content resolver, so it holds no profiles",
            ),
        );
    }
    const addrs = await resolveDotNsAddresses(opts);
    if (!addrs.ok) return addrs;

    try {
        const registry = contractOf(opts.runtime, addrs.value.registry, DOTNS_REGISTRY_ABI);
        // Independent reads, asked for together.
        const [authorised, original] = await Promise.all([
            registry.isAuthorised.query(node, self, { origin }),
            readProfileText(contentResolver, node, opts),
        ]);
        if (!authorised.success) {
            return err(
                new DotNsError("RegistryCall", "registry.isAuthorised call failed", {
                    cause: authorised.value,
                }),
            );
        }
        if (authorised.value !== true) {
            return err(
                new DotNsError(
                    "Unauthorised",
                    `the origin may not write ${JSON.stringify(located.value.label)}`,
                ),
            );
        }
        if (!original.ok) return original;

        const resolver = contractOf(
            opts.runtime,
            contentResolver,
            DOTNS_CONTENT_RESOLVER_WRITE_ABI,
        );
        const prepared = await resolver.setText.prepare(node, PROFILE_TEXT_RECORD_KEY, value, {
            origin,
        });
        if (!prepared.ok) {
            return err(
                new DotNsError("RegistryCall", "contentResolver.setText prepare failed", {
                    cause: prepared.error,
                }),
            );
        }
        return ok({ call: prepared.value as BatchableCall, text: value, original: original.value });
    } catch (cause) {
        return err(new DotNsError("RegistryCall", "profile write preparation failed", { cause }));
    }
}
