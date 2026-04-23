/**
 * createApp - Main entry point for the Product SDK
 *
 * Creates an App instance with wallet, storage, chain, and bulletin APIs.
 */

import type { ChainDefinition } from "polkadot-api";
import type {
    App,
    AppConfig,
    WalletApi,
    StorageApi,
    ChainApi,
    BulletinApi,
    Account,
} from "./types.js";
import { configure, createLogger } from "@parity/product-sdk-logger";
import { createKvStore } from "@parity/product-sdk-storage";
import { SignerManager } from "@parity/product-sdk-signer";
import { BulletinClient, computeCid } from "@parity/product-sdk-bulletin";
import {
    createChainClient,
    getClient,
    isConnected,
    destroyAll,
} from "@parity/product-sdk-chain-client";

const log = createLogger("app");

/**
 * Create a new Product SDK app instance
 *
 * @param config - Application configuration
 * @returns App instance with all APIs
 *
 * @example
 * ```ts
 * import { createApp } from '@parity/product-sdk';
 *
 * // Default: bulletin enabled with paseo environment
 * const app = await createApp({
 *   name: 'my-app',
 *   logLevel: 'info',
 * });
 *
 * // Custom bulletin environment
 * const prodApp = await createApp({
 *   name: 'my-app',
 *   bulletin: { environment: 'polkadot' },
 * });
 *
 * // Disable bulletin entirely
 * const noBulletinApp = await createApp({
 *   name: 'my-app',
 *   bulletin: false,
 * });
 *
 * // Connect wallet
 * const { accounts } = await app.wallet.connect();
 *
 * // Use storage
 * await app.storage.set('key', 'value');
 *
 * // Use bulletin (check for null if it might be disabled)
 * if (app.bulletin) {
 *   const cid = await app.bulletin.upload('hello world');
 * }
 * ```
 */
export async function createApp(config: AppConfig): Promise<App> {
    // Set log level if specified
    if (config.logLevel) {
        configure({ level: config.logLevel });
    }

    log.info("Creating Product SDK app", { name: config.name });

    // Initialize storage (container-only - will throw if not in container)
    const kvStore = await createKvStore({ prefix: config.name });

    // Initialize signer manager
    const signerManager = new SignerManager({
        dappName: config.name,
    });

    // Initialize bulletin client (configurable, defaults to paseo)
    const bulletinEnabled = config.bulletin !== false;
    const bulletinEnvironment =
        typeof config.bulletin === "object" ? config.bulletin.environment : "paseo";
    const bulletinClient = bulletinEnabled
        ? await BulletinClient.create(bulletinEnvironment)
        : null;

    if (bulletinEnabled) {
        log.debug("Bulletin client initialized", { environment: bulletinEnvironment });
    } else {
        log.debug("Bulletin client disabled");
    }

    // Create storage API adapter
    const storageApi: StorageApi = {
        get: (key) => kvStore.get(key),
        set: (key, value) => kvStore.set(key, value),
        getJSON: <T>(key: string) => kvStore.getJSON<T>(key),
        setJSON: <T>(key: string, value: T) => kvStore.setJSON(key, value),
        remove: (key) => kvStore.remove(key),
        clear: async () => {
            // KvStore doesn't have clear - this is a no-op
            log.debug("clear() is not supported in container storage mode");
        },
    };

    // Create wallet API adapter
    const walletApi = createWalletApi(signerManager);

    // Create chain API
    const chainApi: ChainApi = {
        getClient(descriptor) {
            log.debug("getClient called", { genesis: descriptor.genesis });
            const client = getClient(descriptor);
            return client.getTypedApi(descriptor);
        },

        getRawClient(descriptor) {
            log.debug("getRawClient called", { genesis: descriptor.genesis });
            return getClient(descriptor);
        },

        async connect<T extends Record<string, ChainDefinition>>(chains: T) {
            log.debug("connect called", { chains: Object.keys(chains) });
            // Build empty rpcs object (required by API but unused - host routes connections)
            const rpcs = Object.fromEntries(
                Object.keys(chains).map((k) => [k, [] as readonly string[]]),
            ) as { [K in keyof T]: readonly string[] };
            return createChainClient({ chains, rpcs });
        },

        isConnected(descriptor) {
            return isConnected(descriptor);
        },

        destroyAll() {
            log.debug("destroyAll called");
            destroyAll();
        },
    };

    // Create bulletin API adapter (null if disabled)
    const bulletinApi: BulletinApi | null = bulletinClient
        ? {
              upload: async (data) => {
                  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
                  const result = await bulletinClient.upload(bytes);
                  return result.cid;
              },
              fetch: (cid) => bulletinClient.fetchBytes(cid),
              computeCid: (data) => {
                  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
                  return computeCid(bytes);
              },
          }
        : null;

    log.info("Product SDK app created", {
        name: config.name,
        bulletin: bulletinEnabled ? bulletinEnvironment : "disabled",
    });

    return {
        wallet: walletApi,
        storage: storageApi,
        chain: chainApi,
        bulletin: bulletinApi,
        getAppInfo: () => ({ ...config }),
    };
}

/**
 * Create wallet API adapter using SignerManager from leaf package
 */
function createWalletApi(signerManager: SignerManager): WalletApi {
    // Track account change subscribers
    const accountChangeSubscribers = new Set<(account: Account | null) => void>();

    // Subscribe to signer manager state changes
    signerManager.subscribe((state) => {
        const account = state.selectedAccount
            ? {
                  address: state.selectedAccount.address,
                  name: state.selectedAccount.name ?? undefined,
                  source: state.selectedAccount.source,
              }
            : null;
        for (const callback of accountChangeSubscribers) {
            try {
                callback(account);
            } catch (e) {
                log.warn("Account change callback threw", { error: e });
            }
        }
    });

    return {
        async connect(): Promise<{ accounts: Account[] }> {
            const result = await signerManager.connect();
            if (!result.ok) {
                throw new Error(result.error.message);
            }
            return {
                accounts: result.value.map((a) => ({
                    address: a.address,
                    name: a.name ?? undefined,
                    source: a.source,
                })),
            };
        },

        async disconnect(): Promise<void> {
            signerManager.disconnect();
        },

        getAccounts(): Account[] {
            return signerManager.getState().accounts.map((a) => ({
                address: a.address,
                name: a.name ?? undefined,
                source: a.source,
            }));
        },

        getSelectedAccount(): Account | null {
            const selected = signerManager.getState().selectedAccount;
            if (!selected) return null;
            return {
                address: selected.address,
                name: selected.name ?? undefined,
                source: selected.source,
            };
        },

        selectAccount(address: string): void {
            signerManager.selectAccount(address);
        },

        async signMessage(message: string | Uint8Array): Promise<Uint8Array> {
            const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
            const result = await signerManager.signRaw(bytes);
            if (!result.ok) {
                throw new Error(result.error.message);
            }
            return result.value;
        },

        onAccountChange(callback: (account: Account | null) => void): () => void {
            accountChangeSubscribers.add(callback);
            return () => accountChangeSubscribers.delete(callback);
        },

        getProductAccount(): Account | null {
            // Product accounts require async call - this sync API can't support it properly
            // Users should use SignerManager.getProductAccount() directly
            log.warn(
                "getProductAccount() is deprecated - use SignerManager.getProductAccount() directly",
            );
            return null;
        },

        getAnonymousAlias(): string | null {
            // Anonymous aliases require async call - this sync API can't support it properly
            // Users should use SignerManager.getProductAccountAlias() directly
            log.warn(
                "getAnonymousAlias() is deprecated - use SignerManager.getProductAccountAlias() directly",
            );
            return null;
        },

        async createProof(_message: Uint8Array): Promise<Uint8Array> {
            // Ring VRF proofs require SignerManager.createRingVRFProof() directly
            throw new Error(
                "createProof() is not implemented in the App API. " +
                    "Use SignerManager.createRingVRFProof() directly.",
            );
        },
    };
}
