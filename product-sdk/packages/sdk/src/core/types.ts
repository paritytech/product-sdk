// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Core types for @parity/product-sdk
 */

import type { LogLevel } from "@parity/product-sdk-logger";
import type { CloudStorageEnvironment } from "@parity/product-sdk-cloud-storage";
import type { ChainClient } from "@parity/product-sdk-chain-client";
import type { PeopleUsernameChain } from "../identity/dotns.js";
import type { ChainDefinition, TypedApi, PolkadotClient } from "polkadot-api";

export type { LogLevel };
export type { ChainClient };

/** Cloud Storage configuration options */
export interface CloudStorageConfig {
    /** Cloud Storage environment to connect to */
    environment: CloudStorageEnvironment;
}

/** Configuration for createApp */
export interface AppConfig {
    /** Application name - used to derive product accounts and namespace storage */
    name: string;
    /** Log level for SDK operations (default: 'info') */
    logLevel?: LogLevel;
    /**
     * Cloud Storage configuration.
     * - Omit or pass config object to enable (default: { environment: "paseo" })
     * - Pass `false` to disable cloud storage initialization
     */
    cloudStorage?: CloudStorageConfig | false;
}

/** Wallet API exposed by the SDK */
export interface WalletApi {
    /** Connect to available wallet providers */
    connect(): Promise<{ accounts: Account[] }>;
    /** Disconnect from wallet */
    disconnect(): Promise<void>;
    /** Get all available accounts */
    getAccounts(): Account[];
    /** Get currently selected account */
    getSelectedAccount(): Account | null;
    /** Select an account by address */
    selectAccount(address: string): void;
    /** Sign an arbitrary message */
    signMessage(message: string | Uint8Array): Promise<Uint8Array>;
    /**
     * Sign a message with the account that owns a People / People Lite DotNS identity.
     *
     * Pass the People / Individuality chain descriptor used for username lookup.
     * Pass `username` to choose a specific identity. When omitted, the SDK first
     * asks the host for the user's primary DotNS name and signs with the account
     * that owns that username.
     */
    signMessageWithDotNsIdentity(
        args: SignMessageWithDotNsIdentityArgs,
    ): Promise<DotNsIdentitySignature>;
    /** Subscribe to account changes */
    onAccountChange(callback: (account: Account | null) => void): () => void;
    /** Get product-scoped account (container mode only) */
    getProductAccount(): Account | null;
    /** Get anonymous alias via Ring VRF (container mode only) */
    getAnonymousAlias(): string | null;
    /** Create Ring VRF proof (container mode only) */
    createProof(message: Uint8Array): Promise<Uint8Array>;
}

/** Storage API exposed by the SDK */
export interface LocalStorageApi {
    /** Get a value by key */
    get(key: string): Promise<string | null>;
    /** Set a value by key */
    set(key: string, value: string): Promise<void>;
    /** Get a JSON value by key */
    getJSON<T = unknown>(key: string): Promise<T | null>;
    /** Set a JSON value by key */
    setJSON<T = unknown>(key: string, value: T): Promise<void>;
    /** Remove a value by key */
    remove(key: string): Promise<void>;
    /** Clear all values */
    clear(): Promise<void>;
}

/** Chain API exposed by the SDK */
export interface ChainApi {
    /**
     * Get a typed PAPI client for a chain.
     *
     * Connections are routed through the host provider. The chain must be
     * connected first via {@link connect}.
     *
     * @param descriptor - PAPI chain descriptor (from @parity/product-sdk-descriptors or custom)
     * @returns Typed API for the chain
     * @throws If the chain is not connected
     */
    getClient<T extends ChainDefinition>(descriptor: T): TypedApi<T>;

    /**
     * Get the raw PolkadotClient for a chain.
     *
     * Use this for advanced APIs like `createContractRuntime` from `@parity/product-sdk-contracts`.
     *
     * @param descriptor - PAPI chain descriptor
     * @returns Raw PolkadotClient instance
     * @throws If the chain is not connected
     */
    getRawClient(descriptor: ChainDefinition): PolkadotClient;

    /**
     * Connect to one or more chains.
     *
     * Connections are routed through the host provider (container-only).
     * Results are cached - calling with the same descriptors returns existing connections.
     *
     * @param chains - Record of named chain descriptors
     * @returns Connected chain client with typed APIs
     */
    connect<T extends Record<string, ChainDefinition>>(chains: T): Promise<ChainClient<T>>;

    /**
     * Check if a chain is currently connected.
     */
    isConnected(descriptor: ChainDefinition): boolean;

    /**
     * Destroy all chain connections.
     */
    destroyAll(): void;
}

/** Cloud Storage API exposed by the SDK */
export interface CloudStorageApi {
    /**
     * Upload data to the Cloud.
     *
     * Requires a wallet to be connected and an account selected. Throws
     * "No signer available …" otherwise.
     */
    upload(data: string | Uint8Array): Promise<string>;
    /** Fetch data by CID. */
    fetch(cid: string): Promise<Uint8Array>;
    /**
     * Compute the CID for data without uploading.
     *
     * Async because the underlying hash is computed via Web Crypto.
     */
    computeCid(data: string | Uint8Array): Promise<string>;
}

/** The main App instance returned by createApp */
export interface App {
    /** Wallet/signing operations */
    wallet: WalletApi;
    /** Local Key-value storage operations */
    localStorage: LocalStorageApi;
    /** Chain interaction operations */
    chain: ChainApi;
    /** Cloud Storage operations (null if disabled via config) */
    cloudStorage: CloudStorageApi | null;
    /** Get app configuration */
    getAppInfo(): AppConfig;
}

/** Account information */
export interface Account {
    /** Account address (SS58 format) */
    address: string;
    /** Account name/label (if available) */
    name?: string;
    /** Source of the account (host, dev signer, etc.) */
    source: string;
}

/** Arguments for signing with a DotNS / People username identity. */
export interface SignMessageWithDotNsIdentityArgs {
    /**
     * PAPI descriptor for the People / Individuality chain that exposes
     * `Resources.UsernameOwnerOf`.
     *
     * The SDK reuses an already-connected client when one matches this
     * descriptor's genesis. For long-running apps, call
     * `app.chain.connect({ ..., <name>: peopleChain })` once at startup so
     * every subsequent `signMessageWithDotNsIdentity` call reuses the same
     * chainHead subscription. When the chain isn't already connected, the
     * SDK opens a transient connection for the lookup; that connection then
     * lives in the chain-client cache for the rest of the process.
     */
    peopleChain: PeopleUsernameChain;
    /**
     * People / People Lite username to resolve before signing.
     *
     * If omitted, the SDK fetches the primary DotNS name associated with the
     * connected user from the host identity API. Note: that fetch triggers a
     * host identity-permission prompt, so callers who want to avoid the
     * dialog on a likely-miss should resolve the username themselves first.
     *
     * The string is UTF-8 encoded and used as the storage key on
     * `Resources.UsernameOwnerOf` exactly as supplied — no `.dot` suffix
     * handling is applied. On paseo-individuality today usernames are
     * stored as bare strings (e.g. `alice`, not `alice.dot`); pass the
     * exact value the chain has registered.
     */
    username?: string;
    /** Message to sign. Strings are UTF-8 encoded before signing. */
    message: string | Uint8Array;
}

/** Signature produced for a DotNS / People username identity. */
export interface DotNsIdentitySignature {
    /** Username used for the lookup. */
    username: string;
    /** Raw `AccountId32` owner resolved from `Resources.UsernameOwnerOf`. */
    accountId: `0x${string}`;
    /** Signature bytes returned by the host wallet. */
    signature: Uint8Array;
}

// Re-export ChainDefinition from polkadot-api for convenience
export type { ChainDefinition, TypedApi, PolkadotClient } from "polkadot-api";
