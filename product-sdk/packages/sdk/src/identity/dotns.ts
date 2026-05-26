// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS (Polkadot Name Service) utilities
 *
 * Provides name resolution for .dot domains
 */

import { createLogger } from "@parity/product-sdk-logger";
import type { DotNsRecord } from "./types.js";

const log = createLogger("identity");

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
