/**
 * createApp - Main entry point for the Product SDK
 *
 * Creates an App instance with wallet, storage, chain, and cloud storage APIs.
 */

import type { ChainDefinition } from "polkadot-api";
import type {
    App,
    AppConfig,
    WalletApi,
    ChainApi,
    Account,
    CloudStorageApi,
    LocalStorageApi,
} from "./types.js";
import { configure, createLogger } from "@parity/product-sdk-logger";
import { createLocalKvStore } from "@parity/product-sdk-local-storage";
import { SignerManager } from "@parity/product-sdk-signer";
import {
    CloudStorageClient,
    calculateCid,
    createLazySigner,
} from "@parity/product-sdk-cloud-storage";
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
 * // Default: cloud storage enabled with paseo environment
 * const app = await createApp({
 *   name: 'my-app',
 *   logLevel: 'info',
 * });
 *
 * // Custom cloud storage environment
 * const prodApp = await createApp({
 *   name: 'my-app',
 *   cloudStorage: { environment: 'polkadot' },
 * });
 *
 * // Disable cloud storage entirely
 * const noCloudStorageApp = await createApp({
 *   name: 'my-app',
 *   cloudStorage: false,
 * });
 *
 * // Connect wallet
 * const { accounts } = await app.wallet.connect();
 *
 * // Use storage
 * await app.localStorage.set('key', 'value');
 *
 * // Use cloud storage (check for null if it might be disabled)
 * if (app.cloudStorage) {
 *   const cid = await app.cloudStorage.upload('hello world');
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
    const localKvStore = await createLocalKvStore({ prefix: config.name });

    // Initialize signer manager
    const signerManager = new SignerManager({
        dappName: config.name,
    });

    // Initialize cloud storage client (configurable, defaults to paseo).
    //
    // The signer is wrapped lazily so the cloud storage client can be built before
    // an account is selected. Uploads will throw a clear error if no signer
    // is available at submission time. Reads (fetch / fetchJson) don't need
    // a signer and work regardless.
    const cloudStorageEnabled = config.cloudStorage !== false;
    const cloudStorageEnvironment =
        typeof config.cloudStorage === "object" ? config.cloudStorage.environment : "paseo";
    const cloudStorageClient = cloudStorageEnabled
        ? await CloudStorageClient.create({
              environment: cloudStorageEnvironment,
              signer: createLazySigner(() => signerManager.getSigner()),
          })
        : null;

    if (cloudStorageEnabled) {
        log.debug("Cloud Storage client (Bulletin) initialized", {
            environment: cloudStorageEnvironment,
        });
    } else {
        log.debug("Cloud Storage client disabled");
    }

    // Create storage API adapter
    const localStorageApi: LocalStorageApi = {
        get: (key) => localKvStore.get(key),
        set: (key, value) => localKvStore.set(key, value),
        getJSON: <T>(key: string) => localKvStore.getJSON<T>(key),
        setJSON: <T>(key: string, value: T) => localKvStore.setJSON(key, value),
        remove: (key) => localKvStore.remove(key),
        clear: async () => {
            // LocalKvStore doesn't have clear - this is a no-op
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

    // Create Cloud Storage API adapter (null if disabled)
    const cloudStorageApi: CloudStorageApi | null = cloudStorageClient
        ? {
              upload: async (data) => {
                  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
                  // Explicitly request a DAG-PB manifest so chunked uploads always
                  // resolve to a single root CID. Without this, AsyncBulletinClient
                  // can return `result.cid: undefined` for chunked-without-manifest
                  // uploads — but CloudStorageApi.upload promises a string return, and
                  // app consumers expect a CID they can hand to `fetch(cid)`. Keep
                  // the defensive null-check below as belt-and-braces in case the
                  // upstream contract shifts.
                  const result = await cloudStorageClient.store(bytes).withManifest(true).send();
                  if (!result.cid) {
                      throw new Error(
                          "Cloud storage upload returned no CID despite .withManifest(true). Upstream contract may have shifted — file an issue.",
                      );
                  }
                  return result.cid.toString();
              },
              fetch: (cid) => cloudStorageClient.fetchBytes(cid),
              computeCid: async (data) => {
                  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
                  const cid = await calculateCid(bytes);
                  return cid.toString();
              },
          }
        : null;

    log.info("Product SDK app created", {
        name: config.name,
        cloudStorage: cloudStorageEnabled ? cloudStorageEnvironment : "disabled",
    });

    return {
        wallet: walletApi,
        localStorage: localStorageApi,
        chain: chainApi,
        cloudStorage: cloudStorageApi,
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
