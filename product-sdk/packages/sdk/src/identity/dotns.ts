// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS (Polkadot Name Service) utilities
 *
 * Provides name resolution for .dot domains
 */

import { accountIdBytes } from "@parity/product-sdk-address";
import { bytesToHex, hexToBytes } from "@parity/product-sdk-crypto";
import { createLogger } from "@parity/product-sdk-logger";
import type {
    ChainDefinition,
    PalletsTypedef,
    PlainDescriptor,
    RuntimeDescriptor,
    SS58String,
    StorageDescriptor,
    TxDescriptor,
} from "polkadot-api";
import type { DotNsRecord } from "./types.js";

const log = createLogger("identity");

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
 * Check if a string is a valid DotNS name
 *
 * @param name - Name to validate
 * @returns True if valid DotNS name
 */
export function isValidDotNsName(name: string): boolean {
    // Basic validation: alphanumeric, hyphens, ends with .dot
    if (!name.endsWith(".dot")) return false;
    const label = name.slice(0, -4);
    if (label.length < 3 || label.length > 63) return false;
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}

/**
 * Normalize a DotNS name (lowercase, trim whitespace)
 *
 * @param name - Name to normalize
 * @returns Normalized name
 */
export function normalizeDotNsName(name: string): string {
    let normalized = name.toLowerCase().trim();
    if (!normalized.endsWith(".dot")) {
        normalized += ".dot";
    }
    return normalized;
}

/**
 * Resolve a DotNS name to an address.
 *
 * @deprecated Not implemented — throws at runtime. Use
 *   `wallet.signMessageWithDotNsIdentity({ peopleChain, username })` (which
 *   internally calls {@link resolvePeopleUsernameOwner}) for the supported
 *   People-chain username flow.
 *
 * @param name - DotNS name (e.g., "alice.dot")
 * @returns Resolved record or null if not found
 */
export async function resolveDotNs(name: string): Promise<DotNsRecord | null> {
    const normalized = normalizeDotNsName(name);

    if (!isValidDotNsName(normalized)) {
        log.warn("Invalid DotNS name", { name });
        return null;
    }

    log.debug("Resolving DotNS name", { name: normalized });

    // TODO: Implement via PAPI query to DotNS pallet
    throw new Error(
        "resolveDotNs() is not yet implemented. " +
            "This is a skeleton for the Product SDK structure.",
    );
}

/**
 * Reverse resolve an address to a DotNS name.
 *
 * @deprecated Not implemented — throws at runtime. Reverse lookup will land
 *   alongside future identity work; for now resolve forward via
 *   `wallet.signMessageWithDotNsIdentity`.
 *
 * @param address - SS58 address
 * @returns Primary name or null if none set
 */
export async function reverseDotNs(address: string): Promise<string | null> {
    log.debug("Reverse resolving address", { address });

    // TODO: Implement via PAPI query to DotNS pallet
    throw new Error(
        "reverseDotNs() is not yet implemented. " +
            "This is a skeleton for the Product SDK structure.",
    );
}

/**
 * Check if a DotNS name is available for registration.
 *
 * @deprecated Not implemented — depends on {@link resolveDotNs} which throws.
 *
 * @param name - Name to check
 * @returns True if available
 */
export async function isDotNsAvailable(name: string): Promise<boolean> {
    const record = await resolveDotNs(name).catch(() => null);
    return record === null;
}

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
