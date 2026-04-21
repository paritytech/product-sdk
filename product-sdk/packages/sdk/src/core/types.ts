/**
 * Core types for @parity/product-sdk
 */

import type { LogLevel } from "@parity/product-sdk-logger";
import type { Environment as BulletinEnvironment } from "@parity/product-sdk-bulletin";

export type { LogLevel };

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
    /** Get a typed PAPI client for a chain */
    getClient<T>(chain: ChainDescriptor<T>): T;
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

/** Chain descriptor for type inference */
export interface ChainDescriptor<T = unknown> {
    /** Chain identifier */
    id: string;
    /** Chain name */
    name: string;
    /** RPC endpoints */
    endpoints: string[];
    /** Type marker (used for inference) */
    _type?: T;
}
