import type { PolkadotSigner } from "polkadot-api";

import { createLogger } from "@parity/product-sdk-logger";

import {
    AccountNotFoundError,
    DestroyedError,
    HostDisconnectedError,
    HostUnavailableError,
    SigningFailedError,
    type SignerError,
} from "./errors.js";
import { isInsideContainerSync } from "@parity/product-sdk-host";
import { DevProvider } from "./providers/dev.js";
import { ExtensionProvider } from "./providers/extension.js";
import type { ExtensionApi } from "./providers/extension.js";
import { HostProvider } from "./providers/host.js";
import type { ContextualAlias, ProductAccount, RingLocation } from "./providers/host.js";
import type { SignerProvider } from "./providers/types.js";
import { withRetry } from "./retry.js";
import type {
    AccountPersistence,
    ConnectionStatus,
    ProviderType,
    Result,
    SignerAccount,
    SignerManagerOptions,
    SignerState,
} from "./types.js";
import { err, ok } from "./types.js";

const log = createLogger("signer");

const DEFAULT_HOST_TIMEOUT = 10_000;
const DEFAULT_EXTENSION_TIMEOUT = 1_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_SS58_PREFIX = 42;
const DEFAULT_DAPP_NAME = "product-sdk";

// Auto-reconnect settings for host disconnect events
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_INITIAL_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 15_000;

function persistenceStorageKey(dappName: string): string {
    return `product-sdk:signer:${dappName}:selectedAccount`;
}

/* @integration */
/**
 * Auto-detect the best available persistence adapter.
 *
 * Prefers hostLocalStorage (product-sdk) when inside a container because
 * sandboxed iframes may not share localStorage with the host application.
 * Falls back to browser localStorage in standalone environments.
 */
async function detectPersistence(): Promise<AccountPersistence | null> {
    // Try host storage first (container environment)
    if (isInsideContainerSync()) {
        try {
            const sdk = await import("@novasamatech/product-sdk");
            if (sdk.hostLocalStorage) {
                log.debug("using hostLocalStorage for persistence");
                return {
                    getItem: (key) => sdk.hostLocalStorage.readString(key),
                    setItem: (key, value) => sdk.hostLocalStorage.writeString(key, value),
                    removeItem: (key) => sdk.hostLocalStorage.writeString(key, ""),
                };
            }
        } catch {
            // product-sdk not available — fall through to localStorage
        }
    }

    // Fall back to browser localStorage
    try {
        if (typeof globalThis.localStorage !== "undefined") {
            return globalThis.localStorage;
        }
    } catch {
        // localStorage may throw in some environments (e.g. sandboxed iframes)
    }
    return null;
}

function initialState(): SignerState {
    return {
        status: "disconnected",
        accounts: [],
        selectedAccount: null,
        activeProvider: null,
        error: null,
    };
}

/**
 * Core orchestrator for signer management.
 *
 * Manages account discovery and signer creation across multiple providers
 * (Host API, browser extensions, dev accounts). Framework-agnostic —
 * use the subscribe() pattern to integrate with React, Vue, or any framework.
 *
 * @example
 * ```ts
 * const manager = new SignerManager();
 * manager.subscribe(state => console.log(state.status));
 *
 * // Auto-detect: tries Host API first, then browser extensions
 * await manager.connect();
 *
 * // Or connect to a specific provider
 * await manager.connect("dev");
 *
 * // Select account and get signer
 * manager.selectAccount("5GrwvaEF...");
 * const signer = manager.getSigner();
 * ```
 */
export class SignerManager {
    private state: SignerState;
    private provider: SignerProvider | null = null;
    private subscribers = new Set<(state: SignerState) => void>();
    private cleanups: (() => void)[] = [];
    private isDestroyed = false;
    private reconnectController: AbortController | null = null;
    private connectController: AbortController | null = null;

    private readonly ss58Prefix: number;
    private readonly hostTimeout: number;
    private readonly extensionTimeout: number;
    private readonly maxRetries: number;
    private readonly providerFactory: ((type: ProviderType) => SignerProvider) | undefined;
    private readonly dappName: string;
    private readonly persistenceOption: AccountPersistence | null | undefined;
    private resolvedPersistence: AccountPersistence | null | undefined;

    constructor(options?: SignerManagerOptions) {
        this.ss58Prefix = options?.ss58Prefix ?? DEFAULT_SS58_PREFIX;
        this.hostTimeout = options?.hostTimeout ?? DEFAULT_HOST_TIMEOUT;
        this.extensionTimeout = options?.extensionTimeout ?? DEFAULT_EXTENSION_TIMEOUT;
        this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.providerFactory = options?.createProvider;
        this.dappName = options?.dappName ?? DEFAULT_DAPP_NAME;
        // null = disabled, undefined = auto-detect, AccountPersistence = explicit
        this.persistenceOption = options?.persistence;
        this.resolvedPersistence = options?.persistence;
        this.state = initialState();
    }

    private async getPersistence(): Promise<AccountPersistence | null> {
        if (this.persistenceOption === null) return null;
        if (this.persistenceOption !== undefined) return this.persistenceOption;
        // Auto-detect (lazy, cached)
        if (this.resolvedPersistence === undefined) {
            this.resolvedPersistence = await detectPersistence();
        }
        return this.resolvedPersistence ?? null;
    }

    /** Get a snapshot of the current state. */
    getState(): SignerState {
        return this.state;
    }

    /**
     * Subscribe to state changes. The callback fires on every state mutation.
     * Returns an unsubscribe function.
     */
    subscribe(callback: (state: SignerState) => void): () => void {
        this.subscribers.add(callback);
        return () => {
            this.subscribers.delete(callback);
        };
    }

    /**
     * Connect to a provider.
     *
     * If no provider type is specified, runs environment-aware auto-detection:
     *
     * **Inside a container** (iframe/webview):
     * 1. Try direct Host API connection (preferred, idiomatic path)
     * 2. If host fails, try Spektr extension injection as fallback
     * 3. If both fail, return error — no further fallback
     *
     * **Outside a container** (standalone browser):
     * 1. Try browser extensions directly
     * 2. If fails, return error — no host attempt
     *
     * When connecting to a specific provider, it is used directly.
     */
    async connect(providerType?: ProviderType): Promise<Result<SignerAccount[], SignerError>> {
        if (this.isDestroyed) {
            return err(new DestroyedError());
        }

        // Cancel any in-flight connection or reconnect attempt
        this.cancelConnect();
        this.cancelReconnect();
        this.connectController = new AbortController();
        const signal = this.connectController.signal;

        // Clean up previous connection
        this.disconnectInternal();

        this.setState({ status: "connecting", error: null });

        if (providerType) {
            // When explicitly requesting extension inside a container, inject
            // Spektr first so the host wallet appears as a browser extension.
            if (providerType === "extension" && isInsideContainerSync()) {
                await HostProvider.injectSpektr();
            }
            return this.connectToProvider(providerType, signal);
        }

        return this.autoDetect(signal);
    }

    /** Disconnect from the current provider and reset state. */
    disconnect(): void {
        this.cancelConnect();
        this.cancelReconnect();
        this.disconnectInternal();
        this.setState(initialState());
        log.info("disconnected");
    }

    /**
     * Select an account by address.
     * Returns the account on success, or ACCOUNT_NOT_FOUND error.
     */
    selectAccount(address: string): Result<SignerAccount, SignerError> {
        if (this.isDestroyed) {
            return err(new DestroyedError());
        }

        const account = this.state.accounts.find((a) => a.address === address);
        if (!account) {
            log.warn("account not found", { address });
            return err(new AccountNotFoundError(address));
        }

        this.setState({ selectedAccount: account });
        this.persistAccount(address);
        log.debug("account selected", { address });
        return ok(account);
    }

    /**
     * Get the PolkadotSigner for the currently selected account.
     * Returns null if no account is selected or manager is disconnected.
     */
    getSigner(): PolkadotSigner | null {
        return this.state.selectedAccount?.getSigner() ?? null;
    }

    /**
     * Sign arbitrary bytes with the currently selected account.
     *
     * Convenience wrapper around `PolkadotSigner.signBytes` — useful for
     * master key derivation, message signing, and proof generation without
     * constructing a full transaction.
     *
     * Returns a SIGNING_FAILED error if no account is selected or signing fails.
     */
    async signRaw(data: Uint8Array): Promise<Result<Uint8Array, SignerError>> {
        if (this.isDestroyed) {
            return err(new DestroyedError());
        }

        const signer = this.getSigner();
        if (!signer) {
            return err(new SigningFailedError(null, "No account selected"));
        }

        try {
            const signature = await signer.signBytes(data);
            return ok(signature);
        } catch (cause) {
            log.error("signRaw failed", { cause });
            return err(new SigningFailedError(cause));
        }
    }

    // ── Host-only: Product Account API ─────────────────────────────

    /**
     * Get an app-scoped product account from the host.
     *
     * Product accounts are derived by the host wallet for each app, identified
     * by `dotNsIdentifier` (e.g., "mark3t.dot"). Only available when connected
     * via the host provider — returns HOST_UNAVAILABLE otherwise.
     *
     * @example
     * ```ts
     * const result = await manager.getProductAccount("myapp.dot");
     * if (result.ok) {
     *   const signer = result.value.getSigner();
     * }
     * ```
     */
    async getProductAccount(
        dotNsIdentifier: string,
        derivationIndex = 0,
    ): Promise<Result<SignerAccount, SignerError>> {
        if (this.isDestroyed) return err(new DestroyedError());

        const host = this.getHostProvider();
        if (!host) {
            return err(
                new HostUnavailableError("Product accounts require a host provider connection"),
            );
        }
        return host.getProductAccount(dotNsIdentifier, derivationIndex);
    }

    /**
     * Get a contextual alias for a product account via Ring VRF.
     *
     * Aliases prove account membership in a ring without revealing which
     * account produced the alias. Only available when connected via the host
     * provider — returns HOST_UNAVAILABLE otherwise.
     */
    async getProductAccountAlias(
        dotNsIdentifier: string,
        derivationIndex = 0,
    ): Promise<Result<ContextualAlias, SignerError>> {
        if (this.isDestroyed) return err(new DestroyedError());

        const host = this.getHostProvider();
        if (!host) {
            return err(
                new HostUnavailableError(
                    "Product account aliases require a host provider connection",
                ),
            );
        }
        return host.getProductAccountAlias(dotNsIdentifier, derivationIndex);
    }

    /**
     * Create a Ring VRF proof for anonymous operations.
     *
     * Proves that the signer is a member of the ring at the given location
     * without revealing which member. Only available when connected via the
     * host provider — returns HOST_UNAVAILABLE otherwise.
     */
    async createRingVRFProof(
        dotNsIdentifier: string,
        derivationIndex: number,
        location: RingLocation,
        message: Uint8Array,
    ): Promise<Result<Uint8Array, SignerError>> {
        if (this.isDestroyed) return err(new DestroyedError());

        const host = this.getHostProvider();
        if (!host) {
            return err(
                new HostUnavailableError("Ring VRF proofs require a host provider connection"),
            );
        }
        return host.createRingVRFProof(dotNsIdentifier, derivationIndex, location, message);
    }

    /**
     * List available browser extensions.
     *
     * Async because extensions inject into `window.injectedWeb3` asynchronously
     * after page load. Uses the same injection wait as the extension provider.
     */
    async getAvailableExtensions(): Promise<string[]> {
        try {
            const api = await this.loadExtensionApi();
            return api.getInjectedExtensions();
        } catch {
            return [];
        }
    }

    /**
     * Destroy the manager and release all resources.
     * After calling destroy(), the manager is unusable.
     */
    destroy(): void {
        if (this.isDestroyed) return;
        this.isDestroyed = true;
        this.cancelConnect();
        this.cancelReconnect();
        this.disconnectInternal();
        this.subscribers.clear();
        this.state = initialState();
        log.info("manager destroyed");
    }

    // ── Private ──────────────────────────────────────────────────────

    /**
     * Environment-aware auto-detection.
     *
     * Inside a container: direct Host API is the preferred, idiomatic path.
     * If that fails, Spektr extension injection is tried as a fallback.
     * Outside a container: browser extensions are the only viable path.
     */
    private async autoDetect(signal?: AbortSignal): Promise<Result<SignerAccount[], SignerError>> {
        const inContainer = isInsideContainerSync();
        log.info("auto-detecting provider", { inContainer });

        if (inContainer) {
            return this.autoDetectContainer(signal);
        }

        return this.autoDetectStandalone(signal);
    }

    /**
     * Container path: Host API (preferred) → Spektr injection (fallback) → error.
     *
     * The direct Host API is the idiomatic path for container environments.
     * Spektr injection is a compatibility fallback that makes the host wallet
     * appear as a browser extension via `window.injectedWeb3`.
     */
    private async autoDetectContainer(
        signal?: AbortSignal,
    ): Promise<Result<SignerAccount[], SignerError>> {
        // Apply hostTimeout to the host connection attempt
        const hostSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.hostTimeout)])
            : AbortSignal.timeout(this.hostTimeout);

        const hostResult = await this.connectToProvider("host", hostSignal);
        if (hostResult.ok) {
            return hostResult;
        }

        log.info("direct host connection failed, trying Spektr injection fallback", {
            error: hostResult.error,
        });

        // Spektr injection fallback: inject host wallet as browser extension
        const injected = await HostProvider.injectSpektr();
        if (injected) {
            log.info("Spektr injected, connecting via extension provider");
            const extResult = await this.connectToProvider("extension", signal);
            if (extResult.ok) {
                return extResult;
            }
            log.warn("Spektr injection succeeded but extension connection failed", {
                error: extResult.error,
            });
        } else {
            log.warn("Spektr injection failed");
        }

        // All container paths failed
        this.setState({
            status: "disconnected",
            error: hostResult.error,
        });
        return hostResult;
    }

    /** Standalone path: browser extensions only. */
    private async autoDetectStandalone(
        signal?: AbortSignal,
    ): Promise<Result<SignerAccount[], SignerError>> {
        const extResult = await this.connectToProvider("extension", signal);
        if (extResult.ok) {
            return extResult;
        }

        log.warn("no browser extensions available");
        this.setState({
            status: "disconnected",
            error: extResult.error,
        });
        return extResult;
    }

    private async connectToProvider(
        type: ProviderType,
        signal?: AbortSignal,
    ): Promise<Result<SignerAccount[], SignerError>> {
        const provider = this.createProvider(type);

        const result = await provider.connect(signal);
        if (!result.ok) {
            provider.disconnect();
            this.setState({ status: "disconnected", error: result.error });
            return result;
        }

        // Success — set up provider
        this.provider = provider;

        // Wire status change listener
        const statusUnsub = provider.onStatusChange((status) => {
            this.handleProviderStatusChange(status);
        });
        this.cleanups.push(statusUnsub);

        // Wire account change listener
        const accountUnsub = provider.onAccountsChange((accounts) => {
            this.setState({
                accounts,
                // Clear selected if no longer in list
                selectedAccount:
                    accounts.find((a) => a.address === this.state.selectedAccount?.address) ?? null,
            });
        });
        this.cleanups.push(accountUnsub);

        const accounts = result.value;

        // Try to restore persisted account selection
        const persisted = await this.loadPersistedAccount();
        const restoredAccount = persisted ? accounts.find((a) => a.address === persisted) : null;
        const selectedAccount = restoredAccount ?? (accounts.length > 0 ? accounts[0] : null);

        this.setState({
            status: "connected",
            accounts,
            activeProvider: type,
            selectedAccount,
            error: null,
        });

        if (selectedAccount) {
            this.persistAccount(selectedAccount.address);
        }

        log.info("connected", { provider: type, accounts: accounts.length });
        return result;
    }

    private createProvider(type: ProviderType): SignerProvider {
        if (this.providerFactory) {
            return this.providerFactory(type);
        }

        switch (type) {
            case "host":
                return new HostProvider({
                    ss58Prefix: this.ss58Prefix,
                    maxRetries: this.maxRetries,
                    retryDelay: 500,
                });
            case "extension":
                return new ExtensionProvider({
                    injectionWait: this.extensionTimeout,
                    dappName: this.dappName,
                });
            case "dev":
                return new DevProvider({
                    ss58Prefix: this.ss58Prefix,
                });
        }
    }

    /* @integration */
    private handleProviderStatusChange(status: ConnectionStatus): void {
        if (status === "disconnected" && this.state.status === "connected") {
            log.warn("provider disconnected, attempting reconnect");
            this.attemptReconnect();
        }
    }

    /* @integration */
    private attemptReconnect(): void {
        this.cancelReconnect();

        const providerType = this.state.activeProvider;
        if (!providerType) return;

        this.reconnectController = new AbortController();
        const signal = this.reconnectController.signal;

        this.setState({ status: "connecting" });

        withRetry(
            async () => {
                if (signal.aborted) {
                    return err(new HostDisconnectedError("Reconnect cancelled"));
                }

                this.disconnectInternal();
                const provider = this.createProvider(providerType);

                // Compose hostTimeout with reconnect signal for host providers
                const connectSignal =
                    providerType === "host"
                        ? AbortSignal.any([signal, AbortSignal.timeout(this.hostTimeout)])
                        : signal;
                const result = await provider.connect(connectSignal);

                if (!result.ok) return result;

                // Re-wire provider
                this.provider = provider;
                const statusUnsub = provider.onStatusChange((s) =>
                    this.handleProviderStatusChange(s),
                );
                this.cleanups.push(statusUnsub);

                const accountUnsub = provider.onAccountsChange((accounts) => {
                    this.setState({
                        accounts,
                        selectedAccount:
                            accounts.find(
                                (a) => a.address === this.state.selectedAccount?.address,
                            ) ?? null,
                    });
                });
                this.cleanups.push(accountUnsub);

                const accounts = result.value;
                this.setState({
                    status: "connected",
                    accounts,
                    activeProvider: providerType,
                    selectedAccount:
                        accounts.find((a) => a.address === this.state.selectedAccount?.address) ??
                        (accounts.length > 0 ? accounts[0] : null),
                    error: null,
                });

                log.info("reconnected", { provider: providerType });
                return result;
            },
            {
                maxAttempts: RECONNECT_MAX_ATTEMPTS,
                initialDelay: RECONNECT_INITIAL_DELAY,
                maxDelay: RECONNECT_MAX_DELAY,
                signal,
            },
        )
            .then(async (result) => {
                if (!result.ok && !signal.aborted) {
                    log.warn("reconnect to original provider failed, trying auto-detect");
                    const fallback = await this.autoDetect();
                    if (!fallback.ok) {
                        log.error("all reconnect attempts failed", { error: fallback.error });
                        this.setState({
                            status: "disconnected",
                            error: new HostDisconnectedError("Reconnect failed after all retries"),
                        });
                    }
                }
            })
            .catch((cause) => {
                log.error("unexpected reconnect error", { cause });
                this.setState({
                    status: "disconnected",
                    error: new HostDisconnectedError("Reconnect failed unexpectedly"),
                });
            });
    }

    /** Returns the underlying HostProvider if connected via host, or null otherwise. */
    private getHostProvider(): HostProvider | null {
        if (this.provider && this.state.activeProvider === "host") {
            return this.provider as HostProvider;
        }
        return null;
    }

    private cancelConnect(): void {
        if (this.connectController) {
            this.connectController.abort();
            this.connectController = null;
        }
    }

    private cancelReconnect(): void {
        if (this.reconnectController) {
            this.reconnectController.abort();
            this.reconnectController = null;
        }
    }

    private disconnectInternal(): void {
        for (const cleanup of this.cleanups) {
            cleanup();
        }
        this.cleanups = [];

        if (this.provider) {
            this.provider.disconnect();
            this.provider = null;
        }
    }

    private persistAccount(address: string): void {
        void this.getPersistence()
            .then((p) => {
                if (p) {
                    const key = persistenceStorageKey(this.dappName);
                    return Promise.resolve(p.setItem(key, address));
                }
            })
            .catch(() => {
                log.debug("failed to persist selected account");
            });
    }

    private async loadPersistedAccount(): Promise<string | null> {
        try {
            const p = await this.getPersistence();
            if (!p) return null;
            const key = persistenceStorageKey(this.dappName);
            const value = await Promise.resolve(p.getItem(key));
            // Treat empty strings as null (hostLocalStorage uses writeString("") for deletion)
            return value || null;
        } catch {
            log.debug("failed to load persisted account");
            return null;
        }
    }

    private async loadExtensionApi(): Promise<ExtensionApi> {
        const { getInjectedExtensions, connectInjectedExtension } = await import(
            "polkadot-api/pjs-signer"
        );
        return { getInjectedExtensions, connectInjectedExtension };
    }

    private setState(patch: Partial<SignerState>): void {
        this.state = { ...this.state, ...patch };
        for (const subscriber of this.subscribers) {
            subscriber(this.state);
        }
    }
}
