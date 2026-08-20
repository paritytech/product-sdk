// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS (Polkadot Name Service) utilities
 *
 * Name validation and normalization. Every helper here takes the deployment's
 * TLD suffix rather than assuming `.dot`: the TLD is fixed per network when the
 * contracts initialise, so the same string is a valid name on one deployment
 * and meaningless on another. `resolveTld` in `./dotns-registry.js` is what
 * asks the chain which suffix is in play.
 */

import { accountIdBytes } from "@parity/product-sdk-address";
import { bytesToHex, hexToBytes } from "@parity/product-sdk-crypto";
import { stripSuffix } from "./dotns-namehash.js";
import type {
    ChainDefinition,
    PalletsTypedef,
    PlainDescriptor,
    RuntimeDescriptor,
    SS58String,
    StorageDescriptor,
    TxDescriptor,
} from "polkadot-api";

type AnyDescriptorEntry<T> = Record<string, Record<string, T>>;

type PeopleUsernameStorage = {
    Resources: {
        UsernameOwnerOf: StorageDescriptor<[Uint8Array], SS58String, true, never>;
    };
};

type PeopleUsernamePallets = PalletsTypedef<
    PeopleUsernameStorage,
    AnyDescriptorEntry<TxDescriptor<any>>,
    AnyDescriptorEntry<PlainDescriptor<any>>,
    AnyDescriptorEntry<PlainDescriptor<any>>,
    AnyDescriptorEntry<PlainDescriptor<any>>,
    AnyDescriptorEntry<RuntimeDescriptor<any, any>>
>;

/**
 * Descriptor narrowed to "any chain that exposes `Resources.UsernameOwnerOf`".
 *
 * Used as the input to `signMessageWithDotNsIdentity` so the SDK doesn't pin
 * a specific People-chain genesis — anything with the right storage shape
 * (paseo-individuality today, future People Lite, etc.) is accepted.
 */
export type PeopleUsernameChain = ChainDefinition & {
    descriptors: Promise<unknown> & {
        pallets: PeopleUsernamePallets;
    };
};

/**
 * Minimal typed-api shape required to resolve a username on a People chain.
 *
 * This is a narrow structural type — anything with the right
 * `query.Resources.UsernameOwnerOf.getValue` shape works, including a real
 * `TypedApi<PeopleUsernameChain>` slice of a `ChainClient` or a hand-rolled
 * test double.
 */
export type PeopleUsernameQueryApi = {
    query: {
        Resources: {
            UsernameOwnerOf: {
                getValue: (key: Uint8Array) => Promise<SS58String | undefined>;
            };
        };
    };
};

/**
 * Whether `name` is a single registrable label under `suffix`.
 *
 * `suffix` is the deployment's own TLD, including its leading dot, as
 * `resolveTld` reports it — `".dot"` on Paseo Asset Hub Previewnet, `".paseo"`
 * on Next V2. It is required rather than defaulted, because a name is only
 * valid *relative to a deployment*: `alice.dot` is registrable on one network
 * and meaningless on the other, and a default would silently pick one.
 *
 * @param name - Name to validate, already normalized by {@link normalizeDotNsName}
 * @param suffix - The deployment's TLD suffix, e.g. `".paseo"`
 */
export function isValidDotNsName(name: string, suffix: string): boolean {
    if (!name.endsWith(suffix)) return false;
    return isValidLabel(stripSuffix(name, suffix));
}

/**
 * One canonical DNS label, matching the on-chain rule.
 *
 * `StringUtils.isSingleLabel` allows lowercase ASCII, digits and non-edge
 * hyphens up to 63 characters, and the registrar additionally requires 3.
 */
function isValidLabel(label: string): boolean {
    if (label.length < 3 || label.length > 63) return false;
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}

/**
 * Whether a name can be resolved: one or more valid labels under `suffix`.
 *
 * Broader than {@link isValidDotNsName} on purpose. The registrar only mints
 * single labels, so registration keeps the stricter rule, but the registry
 * supports subnodes and `namehash` hashes them, so `bob.alice.paseo` is
 * resolvable even though it is not registrable.
 *
 * @param name - Name to check, already normalized by {@link normalizeDotNsName}
 * @param suffix - The deployment's TLD suffix, e.g. `".paseo"`
 */
export function isResolvableDotNsName(name: string, suffix: string): boolean {
    if (!name.endsWith(suffix)) return false;
    const labels = stripSuffix(name, suffix).split(".");
    return labels.length > 0 && labels.every(isValidLabel);
}

/**
 * Normalize a DotNS name for the deployment identified by `suffix`.
 *
 * Case-folds, applies NFC, trims surrounding whitespace, and drops a single
 * trailing root dot, so `Alice.PASEO.` keys the same as `alice.paseo`. This
 * mirrors `normalize_host` in truapi-server, which is what turns a URL into a
 * dotNS identifier — a name arriving from navigation has to key identically
 * here or the two layers disagree about the same input.
 *
 * The NFC step is defensive only: {@link isValidLabel} and the on-chain
 * `StringUtils.isSingleLabel` both allow lowercase ASCII alone, so no name that
 * survives validation can differ between its composed and decomposed spellings.
 * It costs nothing and it keeps this function honest if the label rule ever
 * widens.
 *
 * **The suffix is appended only when `name` contains no dot at all.** A bare
 * label is the friendly path and gets the deployment's suffix; anything already
 * carrying a dot is left exactly as written, so a name from another deployment
 * survives to be refused by validation rather than being buried under our own
 * suffix. Appending on `!endsWith(suffix)` instead would turn `alice.dot` into
 * `alice.dot.paseo`, which is a well-formed subname and would resolve silently
 * to a node nobody owns.
 *
 * The cost of that rule: a bare multi-label name such as `bob.alice` is no
 * longer completed to `bob.alice.paseo`. Distinguishing it from `alice.dot`
 * would require a hardcoded list of every network's TLD, and there are already
 * more TLDs deployed than any such list contains.
 *
 * @param name - Name to normalize
 * @param suffix - The deployment's TLD suffix, e.g. `".paseo"`
 */
export function normalizeDotNsName(name: string, suffix: string): string {
    const folded = name.trim().normalize("NFC").toLowerCase();
    const normalized = folded.endsWith(".") ? folded.slice(0, -1) : folded;
    return normalized.includes(".") ? normalized : normalized + suffix;
}

// `resolveDotNs` / `reverseDotNs` / `isDotNsAvailable` now live in
// `./dotns-registry.ts` (real `Result`-returning registry calls), replacing the
// throwing skeletons that used to sit here. See that module + the design doc.

/**
 * Resolve a People / People Lite username to its owning `AccountId32`.
 *
 * Queries `Resources.UsernameOwnerOf` on the caller-supplied typed-api fragment.
 * The returned value is the raw 32-byte account id as a `0x`-prefixed hex
 * string, or `null` when no owner is registered for that username.
 *
 * The `username` is UTF-8 encoded as-is — no normalization is applied. Pass
 * the exact byte string the chain stores (typically with the `.dot` suffix).
 *
 * @internal Exposed for unit testing. Consumers should use
 *   `wallet.signMessageWithDotNsIdentity` instead, which orchestrates the
 *   chain-connection lifecycle.
 */
export async function resolvePeopleUsernameOwner(
    username: string,
    peopleApi: PeopleUsernameQueryApi,
): Promise<`0x${string}` | null> {
    const owner = await peopleApi.query.Resources.UsernameOwnerOf.getValue(
        new TextEncoder().encode(username),
    );
    if (!owner) return null;

    return accountIdBytesToHex(accountIdBytes(owner));
}

function assertHex(value: string): `0x${string}` {
    if (!/^0x[0-9a-fA-F]*$/.test(value)) {
        throw new Error(`Expected 0x-prefixed hex string, got ${value}`);
    }
    return value as `0x${string}`;
}

export function accountIdHexToBytes(accountId: `0x${string}`): Uint8Array {
    const bytes = hexToBytes(assertHex(accountId).slice(2));
    if (bytes.length !== 32) {
        throw new Error(`Expected 32-byte AccountId, got ${bytes.length} bytes`);
    }
    return bytes;
}

function accountIdBytesToHex(bytes: Uint8Array): `0x${string}` {
    if (bytes.length !== 32) {
        throw new Error(`Expected 32-byte AccountId, got ${bytes.length} bytes`);
    }
    return `0x${bytesToHex(bytes)}`;
}
