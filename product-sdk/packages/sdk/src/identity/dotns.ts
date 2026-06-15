// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS (Polkadot Name Service) utilities
 *
 * Provides name resolution for .dot domains
 */

import { accountIdBytes } from "@parity/product-sdk-address";
import { createChainClient } from "@parity/product-sdk-chain-client";
import {
    createContractRuntimeFromClient,
    verifySr25519Signature,
    type ContractDryRunAt,
} from "@parity/product-sdk-contracts";
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

export type PeopleUsernameChain = ChainDefinition & {
    descriptors: Promise<unknown> & {
        pallets: PeopleUsernamePallets;
    };
};

type GetPeopleUsernameOwner = (username: Uint8Array) => Promise<SS58String | undefined>;

/** Arguments for verifying a DotNS / People username identity signature. */
export interface VerifyDotNsIdentitySignatureArgs {
    /** PAPI descriptor for the People / Individuality chain containing `Resources.UsernameOwnerOf`. */
    peopleChain: PeopleUsernameChain;
    /** PAPI descriptor for the pallet-revive chain exposing the system precompile. */
    reviveChain: ChainDefinition;
    /** People / People Lite username to resolve before verifying. */
    username: string;
    /** Message that was signed. Strings are UTF-8 encoded before verification. */
    message: string | Uint8Array;
    /** Signature bytes returned by the host wallet. */
    signature: Uint8Array;
    /**
     * Optional expected owner AccountId32. When supplied, verification returns
     * false if the username no longer resolves to this account.
     */
    accountId?: `0x${string}`;
    /** Optional dry-run origin. Defaults to the contracts query fallback origin. */
    origin?: SS58String;
    /** Optional block target for the precompile dry-run. */
    at?: ContractDryRunAt;
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
 * Resolve a People / People Lite username to its owning `AccountId32`.
 *
 * This queries `Resources.UsernameOwnerOf` using the caller-provided People /
 * Individuality chain descriptor. The returned value is the raw 32-byte account
 * id as a `0x`-prefixed hex string.
 */
export async function resolvePeopleUsernameOwner<TPeopleChain extends PeopleUsernameChain>(
    username: string,
    peopleChain: TPeopleChain,
): Promise<`0x${string}` | null> {
    const client = await createChainClient({ chains: { people: peopleChain } });
    const getOwner = client.people.query.Resources.UsernameOwnerOf
        .getValue as unknown as GetPeopleUsernameOwner;
    const owner = await getOwner(new TextEncoder().encode(username));
    if (!owner) return null;

    return accountIdBytesToHex(accountIdBytes(owner));
}

/**
 * Verify that a signature was produced by the current owner of a DotNS /
 * People username.
 *
 * The username owner is resolved from `Resources.UsernameOwnerOf` on the
 * provided People / Individuality chain. The sr25519 signature check itself is
 * delegated to pallet-revive's `sr25519Verify` system precompile on the
 * provided Revive-capable chain.
 */
export async function verifyDotNsIdentitySignature(
    args: VerifyDotNsIdentitySignatureArgs,
): Promise<boolean> {
    const resolvedAccountId = await resolvePeopleUsernameOwner(args.username, args.peopleChain);
    if (!resolvedAccountId) return false;

    if (
        args.accountId !== undefined &&
        assertHex(args.accountId).toLowerCase() !== resolvedAccountId.toLowerCase()
    ) {
        return false;
    }

    const client = await createChainClient({ chains: { revive: args.reviveChain } });
    const runtime = createContractRuntimeFromClient(client.raw.revive, args.reviveChain);
    return verifySr25519Signature(runtime, {
        signature: args.signature,
        message: args.message,
        publicKey: accountIdHexToBytes(resolvedAccountId),
        origin: args.origin,
        at: args.at,
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

function accountIdBytesToHex(bytes: Uint8Array): `0x${string}` {
    if (bytes.length !== 32) {
        throw new Error(`Expected 32-byte AccountId, got ${bytes.length} bytes`);
    }
    return `0x${bytesToHex(bytes)}`;
}
