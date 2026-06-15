// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS (Polkadot Name Service) utilities
 *
 * Provides name resolution for .dot domains
 */

import { accountIdBytes } from "@parity/product-sdk-address";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { bytesToHex, hexToBytes } from "@parity/product-sdk-crypto";
import { createLogger } from "@parity/product-sdk-logger";
import type { ChainDefinition } from "polkadot-api";
import type { DotNsRecord } from "./types.js";

const log = createLogger("identity");

type PeopleUsernameApi = {
    query: {
        Resources: {
            UsernameOwnerOf: {
                getValue(username: Uint8Array): Promise<string | undefined>;
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
 * Resolve a DotNS name to an address
 *
 * @param name - DotNS name (e.g., "alice.dot")
 * @returns Resolved record or null if not found
 *
 * @example
 * ```ts
 * const record = await resolveDotNs('alice.dot');
 * if (record) {
 *   console.log('Address:', record.address);
 * }
 * ```
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
 * Reverse resolve an address to a DotNS name
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
 * Check if a DotNS name is available for registration
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
 * This queries `Resources.UsernameOwnerOf` using the caller-provided People /
 * Individuality chain descriptor. The returned value is the raw 32-byte account
 * id as a `0x`-prefixed hex string.
 */
export async function resolvePeopleUsernameOwner(
    username: string,
    peopleChain: ChainDefinition,
): Promise<`0x${string}` | null> {
    const client = await createChainClient({ chains: { people: peopleChain } });
    const owner = await (
        client.people as unknown as PeopleUsernameApi
    ).query.Resources.UsernameOwnerOf.getValue(new TextEncoder().encode(username));
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
