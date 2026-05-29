// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
import { getHostLocalStorage, requestResourceAllocation } from "@parity/product-sdk-host";
import { DevProvider } from "./providers/dev.js";
import { HostProvider } from "./providers/host.js";
import type { ContextualAlias, ProductAccount, RingLocation } from "./providers/host.js";
import type { SignerProvider } from "./providers/types.js";
import { withRetry } from "./retry.js";
import type {
    AccountPersistence,
    ConnectContext,
    ConnectionStatus,
    OnConnect,
    ProviderType,
    Result,
    SignerAccount,
    SignerManagerOptions,
    SignerState,
} from "./types.js";
import { err, ok } from "./types.js";

const log = createLogger("signer");

const DEFAULT_HOST_TIMEOUT = 10_000;
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
 * Uses hostLocalStorage from the host container. Returns null if unavailable.
 */
async function detectPersistence(): Promise<AccountPersistence | null> {
    try {
        const hostStorage = await getHostLocalStorage();
        if (hostStorage) {
            log.debug("using hostLocalStorage for persistence");
            return {
                getItem: (key) => hostStorage.readString(key),
                setItem: (key, value) => hostStorage.writeString(key, value),
                removeItem: (key) => hostStorage.writeString(key, ""),
            };
        }
    } catch {
        // host storage not available
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

function resolveSelectedAccount(
    accounts: readonly SignerAccount[],
    preferredAddress: string | null | undefined,
): SignerAccount | null {
    if (preferredAddress) {
        const found = accounts.find((a) => a.address === preferredAddress);
        if (found) return found;
    }
    return accounts[0] ?? null;
}

/**
 * Core orchestrator for signer management.
 *
 * Manages account discovery and signer creation via the Host API.
 * Framework-agnostic — use the `subscribe()` pattern to integrate with
 * React, Vue, or any framework.
 *
 * ## Lifecycle
 *
 * ```
 *   disconnected → connecting → connected ──── selectAccount / signRaw / …
 *        ▲             │           │
 *        │             ▼           ▼
 *        └── disconnect()  provider drops → auto-reconnect → connected
 *                                                    (onConnect re-fires)
 *
 *                              ┌─ destroy() ──► (terminal — manager unusable)
 *                              ▼
 * ```
 *
 * ## Callbacks
 *
 * - **`subscribe(cb)`** fires synchronously on every state mutation, in
 *   registration order, inside the call stack that mutated state. It does
 *   **not** fire with the initial state — call `getState()` if you need a
 *   priming read. Multiple mutations during the same operation produce
 *   multiple notifications.
 *
 * - **`onConnect(account, ctx)`** (from `SignerManagerOptions`) fires
 *   exactly when the manager transitions from non-connected to
 *   `"connected"` with a selected account. It fires on a microtask
 *   *after* the `subscribe` notification, so subscribers always observe
 *   `state.status === "connected"` before `onConnect`'s side effects run.
 *   It re-fires after auto-reconnect (the SDK reconnects automatically
 *   when the provider drops), and re-fires after a fresh `connect()`.
 *
 * - **Internal `onAccountsChange` wiring** is worth a behavioral note:
 *   when the provider reports an updated account list, the manager
 *   preserves the current selection if its address is still present, or
 *   sets `selectedAccount` to `null` if it isn't — it does **not** fall
 *   back to `accounts[0]`. The fallback-to-first only applies on
 *   connect-success, where there is no prior selection to preserve.
 *
 * ## `disconnect()` vs `destroy()`
 *
 * - `disconnect()` resets state to initial. Subsequent `connect()` calls
 *   work normally. Reversible.
 * - `destroy()` is **terminal**: the instance is marked unusable, all
 *   subscribers are cleared, and any further call returns `DestroyedError`.
 *   Use in framework teardown (React `useEffect` cleanup, HMR dispose).
 *
 * Both methods cancel any in-flight `connect`, reconnect attempt, and
 * `onConnect` callback (the `ctx.signal` becomes aborted).
 *
 * @example
 * ```ts
 * const manager = new SignerManager({
 *   onConnect: async (_account, { requestResourceAllocation }) => {
 *     await requestResourceAllocation([{ tag: "AutoSigning", value: undefined }]);
 *   },
 * });
 * manager.subscribe(state => console.log(state.status));
 *
 * await manager.connect();        // host provider (default)
 * await manager.connect("dev");   // Alice / Bob / … for testing
 *
 * manager.selectAccount("5GrwvaEF…");
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
    private readonly maxRetries: number;
    private readonly providerFactory: ((type: ProviderType) => SignerProvider) | undefined;
    private readonly dappName: string;
    private readonly persistenceOption: AccountPersistence | null | undefined;
    private resolvedPersistence: AccountPersistence | null | undefined;
    private readonly onConnectCallback: OnConnect | undefined;
    private onConnectController: AbortController | null = null;

    constructor(options?: SignerManagerOptions) {
        this.ss58Prefix = options?.ss58Prefix ?? DEFAULT_SS58_PREFIX;
        this.hostTimeout = options?.hostTimeout ?? DEFAULT_HOST_TIMEOUT;
        this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.providerFactory = options?.createProvider;
        this.dappName = options?.dappName ?? DEFAULT_DAPP_NAME;
        // null = disabled, undefined = auto-detect, AccountPersistence = explicit
        this.persistenceOption = options?.persistence;
        this.resolvedPersistence = options?.persistence;
        this.onConnectCallback = options?.onConnect;
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
     * Subscribe to state changes.
     *
     * The callback fires synchronously on every state mutation, in
     * registration order, inside the call stack that mutated state. It
     * does **not** fire with the current state at subscription time —
     * call {@link getState} if you need a priming read.
     *
     * For "fired once when the user connects" semantics, prefer the
     * {@link SignerManagerOptions.onConnect} option instead of gating on
     * `state.status` inside this callback — `subscribe` will fire many
     * times while connected (`selectAccount`, account swaps, etc.).
     *
     * @returns an unsubscribe function.
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
     * If no provider type is specified, connects to the Host API.
     * The SDK is designed to run exclusively inside a host container.
     *
     * When connecting to a specific provider type:
     * - `"host"`: Connect to the Host API (default, recommended)
     * - `"dev"`: Connect using dev accounts (for testing)
     */
    async connect(providerType?: ProviderType): Promise<Result<SignerAccount[], SignerError>> {
        if (this.isDestroyed) {
            return err(new DestroyedError());
        }

        // Cancel any in-flight connection or reconnect attempt
        this.cancelConnect();
        this.cancelReconnect();
        this.cancelOnConnect();
        this.connectController = new AbortController();
        const signal = this.connectController.signal;

        // Clean up previous connection
        this.disconnectInternal();

        this.setState({ status: "connecting", error: null });

        // Default to host provider - the SDK is designed for container-only usage
        const targetProvider = providerType ?? "host";
        return this.connectToProvider(targetProvider, signal);
    }

    /**
     * Disconnect from the current provider and reset state to initial.
     *
     * Reversible — subsequent `connect()` calls work normally. Cancels
     * any in-flight `connect`, reconnect attempt, or `onConnect` callback
     * (`ctx.signal` becomes aborted).
     */
    disconnect(): void {
        this.cancelConnect();
        this.cancelReconnect();
        this.cancelOnConnect();
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
     * Destroy the manager and release all resources.
     *
     * **Terminal** — clears all subscribers, cancels in-flight work, and
     * marks the instance unusable. Any subsequent method returns
     * `DestroyedError`. Idempotent. Use in framework teardown (React
     * `useEffect` cleanup, HMR dispose). For a reversible reset, use
     * {@link disconnect} instead.
     */
    destroy(): void {
        if (this.isDestroyed) return;
        this.isDestroyed = true;
        this.cancelConnect();
        this.cancelReconnect();
        this.cancelOnConnect();
        this.disconnectInternal();
        this.subscribers.clear();
        this.state = initialState();
        log.info("manager destroyed");
    }

    // ── Private ──────────────────────────────────────────────────────

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

        const persisted = await this.loadPersistedAccount();
        const selectedAccount = resolveSelectedAccount(accounts, persisted);

        this.setState({
            status: "connected",
            accounts,
            activeProvider: type,
            selectedAccount,
            error: null,
        });

        if (selectedAccount) {
            this.persistAccount(selectedAccount.address);
            this.fireOnConnect(selectedAccount);
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
            case "dev":
                return new DevProvider({
                    ss58Prefix: this.ss58Prefix,
                });
            default:
                throw new Error(
                    `Unsupported provider type: ${type}. The SDK only supports "host" and "dev" providers.`,
                );
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
                const selectedAccount = resolveSelectedAccount(
                    accounts,
                    this.state.selectedAccount?.address,
                );
                this.setState({
                    status: "connected",
                    accounts,
                    activeProvider: providerType,
                    selectedAccount,
                    error: null,
                });

                if (selectedAccount) {
                    this.fireOnConnect(selectedAccount);
                }

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
            .then((result) => {
                if (!result.ok && !signal.aborted) {
                    log.error("reconnect failed after all retries", { error: result.error });
                    this.setState({
                        status: "disconnected",
                        error: new HostDisconnectedError("Reconnect failed after all retries"),
                    });
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
        this.connectController?.abort();
        this.connectController = null;
    }

    private cancelReconnect(): void {
        this.reconnectController?.abort();
        this.reconnectController = null;
    }

    private cancelOnConnect(): void {
        this.onConnectController?.abort();
        this.onConnectController = null;
    }

    private fireOnConnect(account: SignerAccount): void {
        const callback = this.onConnectCallback;
        if (!callback) return;

        this.cancelOnConnect();
        const controller = new AbortController();
        this.onConnectController = controller;

        const ctx: ConnectContext = {
            signal: controller.signal,
            requestResourceAllocation,
        };

        // Defer so connect()/attemptReconnect() return before the callback fires —
        // subscribers see "connected" before any onConnect side-effects land.
        queueMicrotask(async () => {
            try {
                await callback(account, ctx);
            } catch (cause) {
                log.warn("onConnect callback threw", { cause });
            } finally {
                // Only clear if this controller is still the active one; a
                // subsequent re-connect may have already swapped in a new one.
                if (this.onConnectController === controller) {
                    this.onConnectController = null;
                }
            }
        });
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

    private setState(patch: Partial<SignerState>): void {
        this.state = { ...this.state, ...patch };
        for (const subscriber of this.subscribers) {
            subscriber(this.state);
        }
    }
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    function mockAccount(
        address = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    ): SignerAccount {
        return {
            address,
            h160Address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            publicKey: new Uint8Array(32),
            name: "MockAccount",
            source: "dev",
            getSigner: () => ({ publicKey: new Uint8Array(32) }) as never,
        };
    }

    function mockProvider(accounts: SignerAccount[] = [mockAccount()]) {
        return {
            type: "dev" as const,
            connect: vi.fn().mockResolvedValue(ok(accounts)),
            disconnect: vi.fn(),
            onStatusChange: vi.fn().mockReturnValue(() => {}),
            onAccountsChange: vi.fn().mockReturnValue(() => {}),
        } satisfies SignerProvider;
    }

    /** Wait for the `onConnect` microtask chain to drain. */
    async function flush(): Promise<void> {
        await Promise.resolve();
        await Promise.resolve();
    }

    describe("SignerManager.onConnect", () => {
        test("fires once on initial connect with the selected account", async () => {
            const onConnect = vi.fn();
            const manager = new SignerManager({
                createProvider: () => mockProvider(),
                onConnect,
            });
            const result = await manager.connect("dev");
            await flush();
            expect(result.ok).toBe(true);
            expect(onConnect).toHaveBeenCalledTimes(1);
            expect(onConnect.mock.calls[0][0].address).toBe(
                "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            );
            manager.destroy();
        });

        test("does not fire on subsequent state mutations while connected", async () => {
            const onConnect = vi.fn();
            const manager = new SignerManager({
                createProvider: () => mockProvider(),
                onConnect,
            });
            await manager.connect("dev");
            await flush();
            // Mutate state — selecting the same account again.
            manager.selectAccount("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
            await flush();
            expect(onConnect).toHaveBeenCalledTimes(1);
            manager.destroy();
        });

        test("fires again after disconnect + reconnect", async () => {
            const onConnect = vi.fn();
            const manager = new SignerManager({
                createProvider: () => mockProvider(),
                onConnect,
            });
            await manager.connect("dev");
            await flush();
            manager.disconnect();
            await manager.connect("dev");
            await flush();
            expect(onConnect).toHaveBeenCalledTimes(2);
            manager.destroy();
        });

        test("does not fire when no account is selected (empty accounts list)", async () => {
            const onConnect = vi.fn();
            const manager = new SignerManager({
                createProvider: () => mockProvider([]),
                onConnect,
            });
            await manager.connect("dev");
            await flush();
            expect(onConnect).not.toHaveBeenCalled();
            manager.destroy();
        });

        test("errors thrown from onConnect are caught and don't break connected state", async () => {
            const onConnect = vi.fn().mockRejectedValue(new Error("boom"));
            const manager = new SignerManager({
                createProvider: () => mockProvider(),
                onConnect,
            });
            const result = await manager.connect("dev");
            await flush();
            expect(result.ok).toBe(true);
            expect(manager.getState().status).toBe("connected");
            manager.destroy();
        });

        test("ctx.signal aborts when disconnect() runs mid-callback", async () => {
            const signals: AbortSignal[] = [];
            const onConnect = vi.fn().mockImplementation((_, ctx) => {
                signals.push(ctx.signal);
                return new Promise<void>(() => {});
            });
            const manager = new SignerManager({
                createProvider: () => mockProvider(),
                onConnect,
            });
            await manager.connect("dev");
            await flush();
            expect(signals[0]?.aborted).toBe(false);
            manager.disconnect();
            expect(signals[0]?.aborted).toBe(true);
            manager.destroy();
        });

        test("ctx.signal aborts when destroy() runs mid-callback", async () => {
            const signals: AbortSignal[] = [];
            const onConnect = vi.fn().mockImplementation((_, ctx) => {
                signals.push(ctx.signal);
                return new Promise<void>(() => {});
            });
            const manager = new SignerManager({
                createProvider: () => mockProvider(),
                onConnect,
            });
            await manager.connect("dev");
            await flush();
            manager.destroy();
            expect(signals[0]?.aborted).toBe(true);
        });

        test("ctx exposes requestResourceAllocation function", async () => {
            const onConnect = vi.fn().mockImplementation((_, ctx) => {
                expect(typeof ctx.requestResourceAllocation).toBe("function");
            });
            const manager = new SignerManager({
                createProvider: () => mockProvider(),
                onConnect,
            });
            await manager.connect("dev");
            await flush();
            expect(onConnect).toHaveBeenCalledTimes(1);
            manager.destroy();
        });

        test("re-connecting cancels in-flight onConnect from the prior session", async () => {
            const signals: AbortSignal[] = [];
            const onConnect = vi.fn().mockImplementation((_, ctx) => {
                signals.push(ctx.signal);
                return new Promise<void>(() => {});
            });
            const manager = new SignerManager({
                createProvider: () => mockProvider(),
                onConnect,
            });
            await manager.connect("dev");
            await flush();
            await manager.connect("dev");
            await flush();
            expect(signals).toHaveLength(2);
            expect(signals[0].aborted).toBe(true);
            expect(signals[1].aborted).toBe(false);
            manager.destroy();
        });
    });
}
