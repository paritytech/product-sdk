/**
 * Core types for @parity/product-sdk
 */

import type { LogLevel } from "@parity/product-sdk-logger";
import type { Environment as BulletinEnvironment } from "@parity/product-sdk-bulletin";
import type { ChainClient } from "@parity/product-sdk-chain-client";
import type { ChainDefinition, TypedApi, PolkadotClient } from "polkadot-api";

export type { LogLevel };
export type { ChainClient };

/** Bulletin configuration options */
export interface BulletinConfig {
    /** Bulletin environment to connect to */
    environment: BulletinEnvironment;
}

/** Configuration for createApp */
export interface AppConfig {
    /** Application name - used to derive product accounts and namespace storage */
    name: string;
    /** Log level for SDK operations (default: 'info') */
    logLevel?: LogLevel;
    /**
     * Bulletin Chain configuration.
     * - Omit or pass config object to enable (default: { environment: "paseo" })
     * - Pass `false` to disable bulletin initialization
     */
    bulletin?: BulletinConfig | false;
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
export interface StorageApi {
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
     * Use this for advanced APIs like `createInkSdk` from `@polkadot-api/sdk-ink`.
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

/** Bulletin Chain API exposed by the SDK */
export interface BulletinApi {
    /** Upload data to Bulletin Chain */
    upload(data: string | Uint8Array): Promise<string>;
    /** Fetch data by CID */
    fetch(cid: string): Promise<Uint8Array>;
    /** Compute CID for data without uploading */
    computeCid(data: string | Uint8Array): string;
}

/** The main App instance returned by createApp */
export interface App {
    /** Wallet/signing operations */
    wallet: WalletApi;
    /** Key-value storage operations */
    storage: StorageApi;
    /** Chain interaction operations */
    chain: ChainApi;
    /** Bulletin Chain operations (null if disabled via config) */
    bulletin: BulletinApi | null;
    /** Get app configuration */
    getAppInfo(): AppConfig;
}

/** Account information */
export interface Account {
    /** Account address (SS58 format) */
    address: string;
    /** Account name/label (if available) */
    name?: string;
    /** Source of the account (extension name, host, etc.) */
    source: string;
}

// Re-export ChainDefinition from polkadot-api for convenience
export type { ChainDefinition, TypedApi, PolkadotClient } from "polkadot-api";
