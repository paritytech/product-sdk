// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS (Polkadot Name Service) utilities
 *
 * Provides name resolution for .dot domains
 */

import { createLogger } from "@parity/product-sdk-logger";
import { getHostProvider } from "@parity/product-sdk-host";
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";
import { summit_individuality } from "@parity/product-sdk-descriptors/summit-individuality";
import { hexToBytes } from "@parity/product-sdk-crypto";
import { Blake2128Concat, Bytes, Storage } from "@polkadot-api/substrate-bindings";
import type { DotNsRecord } from "./types.js";

const log = createLogger("identity");

export type PeopleUsernameEnvironment = "paseo" | "summit";

const PEOPLE_USERNAME_OWNER_DESCRIPTORS_BY_ENVIRONMENT = {
    paseo: paseo_individuality,
    summit: summit_individuality,
} as const;

const usernameOwnerOfStorage = Storage("Resources")("UsernameOwnerOf", [Bytes(), Blake2128Concat]);

export interface ResolvePeopleUsernameOwnerOptions {
    /** Environment whose People / Individuality deployment should be queried. */
    environment?: PeopleUsernameEnvironment;
    /** Explicit People / Individuality chain genesis hash. Overrides `environment`. */
    genesisHash?: `0x${string}`;
}

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
 * Build the raw Substrate storage key for `Resources.UsernameOwnerOf(username)`.
 *
 * The map key is the SCALE-encoded `Vec<u8>` username, hashed with
 * `Blake2_128Concat` after the pallet/item `twox128` prefixes.
 */
export function peopleUsernameOwnerStorageKey(username: string): `0x${string}` {
    return usernameOwnerOfStorage.enc(new TextEncoder().encode(username)) as `0x${string}`;
}

/**
 * Resolve a People / People Lite username to its owning `AccountId32`.
 *
 * This queries `Resources.UsernameOwnerOf` on the selected People /
 * Individuality deployment through the host chain provider. The returned value
 * is the raw 32-byte account id as a `0x`-prefixed hex string.
 */
export async function resolvePeopleUsernameOwner(
    username: string,
    options: ResolvePeopleUsernameOwnerOptions = {},
): Promise<`0x${string}` | null> {
    const key = peopleUsernameOwnerStorageKey(username);
    const genesisHashes = peopleUsernameOwnerGenesisHashes(options);
    const failures: unknown[] = [];
    let foundHostProvider = false;

    for (const genesisHash of genesisHashes) {
        try {
            const provider = await getHostProvider(genesisHash);
            if (!provider) continue;

            foundHostProvider = true;
            const value = await jsonRpc<`0x${string}` | null>(provider, "state_getStorage", [key]);
            if (value) return value;
        } catch (cause) {
            failures.push(cause);
        }
    }

    if (!foundHostProvider && failures.length > 0) {
        throw new Error(
            "resolvePeopleUsernameOwner: no supported People chain provider available",
            {
                cause: failures[0],
            },
        );
    }
    if (!foundHostProvider) {
        throw new Error("resolvePeopleUsernameOwner: host chain provider unavailable");
    }

    return null;
}

function peopleUsernameOwnerGenesisHashes(
    options: ResolvePeopleUsernameOwnerOptions,
): `0x${string}`[] {
    if (options.genesisHash) return [options.genesisHash];
    if (options.environment) {
        return [
            descriptorGenesis(
                PEOPLE_USERNAME_OWNER_DESCRIPTORS_BY_ENVIRONMENT[options.environment],
            ),
        ];
    }
    return Object.values(PEOPLE_USERNAME_OWNER_DESCRIPTORS_BY_ENVIRONMENT).map(descriptorGenesis);
}

function descriptorGenesis(descriptor: { genesis?: string }): `0x${string}` {
    if (!descriptor.genesis?.match(/^0x[0-9a-fA-F]{64}$/)) {
        throw new Error("People / Individuality descriptor is missing a valid genesis hash");
    }
    return descriptor.genesis as `0x${string}`;
}

async function jsonRpc<T>(provider: unknown, method: string, params: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        let send: (message: string) => void;
        let disconnect = () => {};
        const timer = setTimeout(() => {
            disconnect();
            reject(new Error(`JSON-RPC ${method} timed out`));
        }, 15_000);

        try {
            const connection = (provider as (onMessage: (message: string) => void) => unknown)(
                (message) => {
                    const response = JSON.parse(message) as {
                        id?: number;
                        result?: T;
                        error?: { message?: string };
                    };
                    if (response.id !== id) return;
                    clearTimeout(timer);
                    disconnect();
                    if (response.error) {
                        reject(new Error(response.error.message ?? `JSON-RPC ${method} failed`));
                    } else {
                        resolve(response.result as T);
                    }
                },
            );
            if (typeof connection === "function") {
                send = connection as (message: string) => void;
            } else {
                const rpcConnection = connection as {
                    send(message: string): void;
                    disconnect?: () => void;
                };
                send = (message) => rpcConnection.send(message);
                disconnect = () => rpcConnection.disconnect?.();
            }
            send(JSON.stringify({ id, jsonrpc: "2.0", method, params }));
        } catch (cause) {
            clearTimeout(timer);
            disconnect();
            reject(cause);
        }
    });
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

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    describe("people username storage keys", () => {
        test("builds Resources.UsernameOwnerOf storage key", () => {
            expect(peopleUsernameOwnerStorageKey("pgherveou.05")).toBe(
                "0x2111e0df19de9563b58301e5f7e00743099c711e270af23bb9a4e46759a9761d9ce33dee7b061d3cc30cac44f0a79ba730706768657276656f752e3035",
            );
        });
    });
}
