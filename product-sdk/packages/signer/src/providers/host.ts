// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { deriveH160, ss58Encode } from "@parity/product-sdk-address";
import { createLogger } from "@parity/product-sdk-logger";

import {
    HostRejectedError,
    HostUnavailableError,
    NoAccountsError,
    type SignerError,
} from "../errors.js";
import { withRetry } from "../retry.js";
import type { ConnectionStatus, ProviderType, Result, SignerAccount } from "../types.js";
import { err, ok } from "../types.js";
import type { SignerProvider, Unsubscribe } from "./types.js";

const log = createLogger("signer:host");

/** Options for the Host API provider. */
export interface HostProviderOptions {
    /** SS58 prefix for address encoding. Default: 42 */
    ss58Prefix?: number;
    /** Max retry attempts for initial connection. Default: 3 */
    maxRetries?: number;
    /** Initial retry delay in ms. Default: 500 */
    retryDelay?: number;
    /**
     * Custom SDK loader. Defaults to `import("@novasamatech/host-api-wrapper")`.
     * Override this for testing or custom SDK setups.
     * @internal
     */
    loadSdk?: () => Promise<ProductSdkModule>;
    /**
     * Custom loader for `@novasamatech/host-api` (used to construct the
     * `ChainSubmit` permission request). Defaults to dynamic import.
     * @internal
     */
    loadHostApiEnum?: () => Promise<HostApiEnumHelper>;
    /**
     * Whether to request the host's `ChainSubmit` permission after a
     * successful `connect()`. Without this, subsequent signing requests are
     * rejected by the host with `PermissionDenied`. Default: `true`.
     *
     * Set to `false` if your app needs to defer the permission prompt or
     * drives it manually.
     *
     * (Previously named `requestTransactionSubmitPermission` — alias kept
     * for backwards compatibility but the new wire format uses `ChainSubmit`.)
     */
    requestChainSubmitPermission?: boolean;
    /** @deprecated Renamed to `requestChainSubmitPermission`. */
    requestTransactionSubmitPermission?: boolean;
}

/**
 * A product account — an app-scoped derived account managed by the host wallet.
 *
 * The host derives a unique keypair for each app (identified by `dotNsIdentifier`)
 * so apps get their own account that the user controls but is scoped to the app.
 */
export interface ProductAccount {
    /** App identifier (e.g., "mark3t.dot"). */
    dotNsIdentifier: string;
    /** Derivation index within the app scope. Default: 0 */
    derivationIndex: number;
    /** Raw public key (32 bytes). */
    publicKey: Uint8Array;
}

/**
 * A contextual alias obtained from Ring VRF.
 *
 * Proves account membership in a ring without revealing which account.
 */
export interface ContextualAlias {
    /** Ring context (32 bytes). */
    context: Uint8Array;
    /** The Ring VRF alias bytes. */
    alias: Uint8Array;
}

/**
 * Location of a Ring VRF ring on-chain.
 *
 * Matches the product-sdk's `RingLocation` codec shape.
 */
export interface RingLocation {
    genesisHash: string;
    ringRootHash: string;
    hints?: { palletInstance?: number } | undefined;
}

// Minimal types matching product-sdk's actual API shape.
// We define these locally so the SDK remains an optional peer dep.
interface RawAccount {
    publicKey: Uint8Array;
    name?: string | undefined;
}

// Minimal neverthrow ResultAsync shape (product-sdk uses neverthrow internally)
interface NeverthrowResultAsync<T, E> {
    match: <A, B = A>(ok: (t: T) => A, err: (e: E) => B) => Promise<A | B>;
}

/**
 * Pin product-account signing to Nova's `host_create_transaction` path.
 *
 * The `createTransaction` path forwards opaque signed-extension bytes to
 * the host for metadata-driven decoding, so unknown extensions (e.g.
 * `AsPgas` on Paseo Next) survive end-to-end. The alternate
 * `"signPayload"` path wraps via PJS and throws
 * `"PJS does not support this signed-extension: AsPgas"` on those chains.
 *
 * Nova's `host-api-wrapper@0.7.9` already defaults to `"createTransaction"`,
 * so this is a defensive pin rather than an opt-in — it guards against a
 * future upstream default flip and makes the routing legible at the call
 * site. The legacy-account signer doesn't expose this switch.
 */
const PRODUCT_SIGNER_TYPE = "createTransaction" as const;

/** @internal */
export interface AccountsProvider {
    getLegacyAccounts: () => NeverthrowResultAsync<RawAccount[], unknown>;
    getLegacyAccountSigner: (account: ProductAccount) => import("polkadot-api").PolkadotSigner;
    getProductAccount: (
        dotNsIdentifier: string,
        derivationIndex?: number,
    ) => NeverthrowResultAsync<RawAccount, unknown>;
    getProductAccountSigner: (
        account: ProductAccount,
        signerType?: "signPayload" | "createTransaction",
    ) => import("polkadot-api").PolkadotSigner;
    getProductAccountAlias: (
        dotNsIdentifier: string,
        derivationIndex?: number,
    ) => NeverthrowResultAsync<ContextualAlias, unknown>;
    createRingVRFProof: (
        dotNsIdentifier: string,
        derivationIndex: number,
        location: unknown,
        message: Uint8Array,
    ) => NeverthrowResultAsync<Uint8Array, unknown>;
    subscribeAccountConnectionStatus: (
        callback: (status: string) => void,
    ) => { unsubscribe: () => void } | (() => void);
}

/** @internal */
export interface HostApiPermissionBridge {
    /**
     * Request a Host API permission. Product-sdk's `hostApi.permission(...)`
     * takes a tagged enum like `enumValue("v1", { tag: "TransactionSubmit" })`
     * and returns a neverthrow ResultAsync.
     */
    permission: (request: unknown) => NeverthrowResultAsync<unknown, unknown>;
}

/** @internal */
export interface HostApiEnumHelper {
    enumValue: (version: string, value: { tag: string; value?: unknown }) => unknown;
}

/** @internal */
export interface ProductSdkModule {
    createAccountsProvider: () => AccountsProvider;
    /** Present from product-sdk ≥ 0.6; used to request TransactionSubmit. */
    hostApi?: HostApiPermissionBridge;
}

/* @integration */
async function defaultLoadSdk(): Promise<ProductSdkModule> {
    return (await import("@novasamatech/host-api-wrapper")) as unknown as ProductSdkModule;
}

/* @integration */
async function defaultLoadHostApiEnum(): Promise<HostApiEnumHelper> {
    return (await import("@novasamatech/host-api")) as unknown as HostApiEnumHelper;
}

/**
 * Provider for the Host API (Polkadot Desktop / Android).
 *
 * Dynamically imports `@novasamatech/host-api-wrapper` at runtime so it remains
 * an optional peer dependency. Apps running outside a host container will
 * gracefully get a `HOST_UNAVAILABLE` error.
 *
 * Supports both non-product accounts (user's external wallets) and product
 * accounts (app-scoped derived accounts managed by the host).
 */
export class HostProvider implements SignerProvider {
    readonly type: ProviderType = "host";
    private readonly ss58Prefix: number;
    private readonly maxRetries: number;
    private readonly retryDelay: number;
    private readonly loadSdk: () => Promise<ProductSdkModule>;
    private readonly loadHostApiEnum: () => Promise<HostApiEnumHelper>;
    private readonly requestChainSubmitPermission: boolean;

    private accountsProvider: AccountsProvider | null = null;
    private statusCleanup: (() => void) | null = null;
    private statusListeners = new Set<(status: ConnectionStatus) => void>();
    private accountListeners = new Set<(accounts: SignerAccount[]) => void>();

    constructor(options?: HostProviderOptions) {
        this.ss58Prefix = options?.ss58Prefix ?? 42;
        this.maxRetries = options?.maxRetries ?? 3;
        this.retryDelay = options?.retryDelay ?? 500;
        this.loadSdk = options?.loadSdk ?? defaultLoadSdk;
        this.loadHostApiEnum = options?.loadHostApiEnum ?? defaultLoadHostApiEnum;
        // New name takes precedence; fall back to the deprecated alias.
        this.requestChainSubmitPermission =
            options?.requestChainSubmitPermission ??
            options?.requestTransactionSubmitPermission ??
            true;
    }

    async connect(signal?: AbortSignal): Promise<Result<SignerAccount[], SignerError>> {
        log.debug("attempting Host API connection");

        return withRetry(
            async () => {
                if (signal?.aborted) {
                    return err(new HostUnavailableError("Connection aborted"));
                }
                return this.tryConnect();
            },
            {
                maxAttempts: this.maxRetries,
                initialDelay: this.retryDelay,
                signal,
            },
        );
    }

    disconnect(): void {
        if (this.statusCleanup) {
            this.statusCleanup();
            this.statusCleanup = null;
        }
        this.accountsProvider = null;
        this.statusListeners.clear();
        this.accountListeners.clear();
        log.debug("host provider disconnected");
    }

    onStatusChange(callback: (status: ConnectionStatus) => void): Unsubscribe {
        this.statusListeners.add(callback);
        return () => {
            this.statusListeners.delete(callback);
        };
    }

    onAccountsChange(callback: (accounts: SignerAccount[]) => void): Unsubscribe {
        this.accountListeners.add(callback);
        return () => {
            this.accountListeners.delete(callback);
        };
    }

    // ── Product Account API ──────────────────────────────────────────

    /**
     * Get an app-scoped product account from the host.
     *
     * Product accounts are derived by the host wallet for each app, identified
     * by `dotNsIdentifier` (e.g., "mark3t.dot"). The user controls these accounts
     * but they are scoped to the requesting app.
     *
     * Requires a prior successful `connect()` call.
     */
    async getProductAccount(
        dotNsIdentifier: string,
        derivationIndex = 0,
    ): Promise<Result<SignerAccount, SignerError>> {
        if (!this.accountsProvider) {
            return err(new HostUnavailableError("Host provider is not connected"));
        }

        try {
            const raw = (await this.accountsProvider
                .getProductAccount(dotNsIdentifier, derivationIndex)
                .match(
                    (account) => account,
                    (error) => {
                        throw new Error(
                            `Host rejected product account request: ${formatError(error)}`,
                        );
                    },
                )) as RawAccount;

            const address = ss58Encode(raw.publicKey, this.ss58Prefix);
            const productAccount: ProductAccount = {
                dotNsIdentifier,
                derivationIndex,
                publicKey: raw.publicKey,
            };

            return ok({
                address,
                h160Address: deriveH160(raw.publicKey),
                publicKey: raw.publicKey,
                name: raw.name ?? null,
                source: "host" as const,
                getSigner: () => {
                    if (!this.accountsProvider) {
                        throw new Error("Host provider is disconnected");
                    }
                    return this.accountsProvider.getProductAccountSigner(
                        productAccount,
                        PRODUCT_SIGNER_TYPE,
                    );
                },
            });
        } catch (cause) {
            log.error("failed to get product account", { cause });
            return err(
                new HostRejectedError(
                    cause instanceof Error ? cause.message : "Failed to get product account",
                ),
            );
        }
    }

    /**
     * Get a PolkadotSigner for a product account.
     *
     * Convenience method for when you already have the product account details.
     * Requires a prior successful `connect()` call.
     *
     * Routing is pinned to `signerType: "createTransaction"` via
     * {@link PRODUCT_SIGNER_TYPE} so unknown signed extensions (e.g. `AsPgas`
     * on Paseo Next) are forwarded to the host as opaque bytes for
     * metadata-driven decoding, rather than going through the PJS bridge
     * that throws on unknown extensions.
     */
    getProductAccountSigner(account: ProductAccount): import("polkadot-api").PolkadotSigner {
        if (!this.accountsProvider) {
            throw new Error("Host provider is not connected");
        }
        return this.accountsProvider.getProductAccountSigner(account, PRODUCT_SIGNER_TYPE);
    }

    /**
     * Get a contextual alias for a product account via Ring VRF.
     *
     * Aliases prove account membership in a ring without revealing which
     * account produced the alias.
     *
     * Requires a prior successful `connect()` call.
     */
    async getProductAccountAlias(
        dotNsIdentifier: string,
        derivationIndex = 0,
    ): Promise<Result<ContextualAlias, SignerError>> {
        if (!this.accountsProvider) {
            return err(new HostUnavailableError("Host provider is not connected"));
        }

        try {
            const alias = (await this.accountsProvider
                .getProductAccountAlias(dotNsIdentifier, derivationIndex)
                .match(
                    (result) => result,
                    (error) => {
                        throw new Error(`Host rejected alias request: ${formatError(error)}`);
                    },
                )) as ContextualAlias;

            return ok(alias);
        } catch (cause) {
            log.error("failed to get product account alias", { cause });
            return err(
                new HostRejectedError(
                    cause instanceof Error ? cause.message : "Failed to get product account alias",
                ),
            );
        }
    }

    /**
     * Create a Ring VRF proof for anonymous operations.
     *
     * Proves that the signer is a member of the ring at the given location
     * without revealing which member. Used for privacy-preserving protocols.
     *
     * Requires a prior successful `connect()` call.
     */
    async createRingVRFProof(
        dotNsIdentifier: string,
        derivationIndex: number,
        location: RingLocation,
        message: Uint8Array,
    ): Promise<Result<Uint8Array, SignerError>> {
        if (!this.accountsProvider) {
            return err(new HostUnavailableError("Host provider is not connected"));
        }

        try {
            const proof = (await this.accountsProvider
                .createRingVRFProof(dotNsIdentifier, derivationIndex, location, message)
                .match(
                    (result) => result,
                    (error) => {
                        throw new Error(
                            `Host rejected Ring VRF proof request: ${formatError(error)}`,
                        );
                    },
                )) as Uint8Array;

            return ok(proof);
        } catch (cause) {
            log.error("failed to create Ring VRF proof", { cause });
            return err(
                new HostRejectedError(
                    cause instanceof Error ? cause.message : "Failed to create Ring VRF proof",
                ),
            );
        }
    }

    // ── Private ──────────────────────────────────────────────────────

    private async tryConnect(): Promise<Result<SignerAccount[], SignerError>> {
        // Step 1: Load product-sdk
        let sdk: ProductSdkModule;
        try {
            sdk = await this.loadSdk();
        } catch (cause) {
            log.warn("product-sdk not available", { cause });
            return err(
                new HostUnavailableError(
                    cause instanceof Error
                        ? `product-sdk import failed: ${cause.message}`
                        : "product-sdk is not installed",
                ),
            );
        }

        // Step 2: Create accounts provider
        const provider = sdk.createAccountsProvider();
        this.accountsProvider = provider;

        // Step 3: Fetch non-product accounts
        let rawAccounts: RawAccount[];
        try {
            rawAccounts = (await provider.getLegacyAccounts().match(
                (accounts) => accounts,
                (error) => {
                    throw new Error(`Host rejected account request: ${formatError(error)}`);
                },
            )) as RawAccount[];
        } catch (cause) {
            log.error("failed to get accounts from host", { cause });
            return err(
                new HostRejectedError(
                    cause instanceof Error ? cause.message : "Failed to get accounts from host",
                ),
            );
        }

        if (rawAccounts.length === 0) {
            log.warn("host returned no accounts");
            return err(new NoAccountsError("host"));
        }

        // Step 4: Request ChainSubmit permission up-front.
        //
        // The host gates signing on this permission — without it, the
        // production host rejects every sign request with `PermissionDenied`
        // at both `handleSignPayload` (legacy account path) and
        // `host_create_transaction` (product-account path), which typically
        // manifests as a silently-hanging tx. Doing it once during connect()
        // matches what production apps need and spares consumers the
        // boilerplate.
        //
        // We don't fail `connect()` if this step fails: the consumer can still
        // use the signer for read-only code paths, and the actual sign call
        // will surface a clear error if permission is missing.
        //
        // The legal v1 RemotePermission variants per
        // `@novasamatech/host-api@0.7.7` are: Remote, WebRTC, ChainSubmit,
        // PreimageSubmit, StatementSubmit. ChainSubmit is the chain-tx
        // permission (was named TransactionSubmit in earlier host-api
        // revisions; renamed in 0.7).
        if (this.requestChainSubmitPermission && sdk.hostApi) {
            try {
                const hostApiEnum = await this.loadHostApiEnum();
                const request = hostApiEnum.enumValue("v1", {
                    tag: "ChainSubmit",
                    value: undefined,
                });
                await sdk.hostApi.permission(request).match(
                    () => {
                        log.debug("ChainSubmit permission granted");
                    },
                    (error) => {
                        log.warn("ChainSubmit permission rejected by host", {
                            error: formatError(error),
                        });
                    },
                );
            } catch (cause) {
                log.warn("failed to request ChainSubmit permission", { cause });
            }
        }

        // Step 5: Map to SignerAccount[]
        const accounts = this.mapAccounts(rawAccounts);
        log.info("host connected", { accounts: accounts.length });

        // Step 6: Subscribe to connection status
        const sub = provider.subscribeAccountConnectionStatus((status) => {
            const mapped: ConnectionStatus = status === "connected" ? "connected" : "disconnected";
            log.debug("host status changed", { status: mapped });
            for (const listener of this.statusListeners) {
                listener(mapped);
            }
        });
        this.statusCleanup = typeof sub === "function" ? sub : () => sub.unsubscribe();

        return ok(accounts);
    }

    private mapAccounts(rawAccounts: ReadonlyArray<RawAccount>): SignerAccount[] {
        return rawAccounts.map((raw) => {
            const address = ss58Encode(raw.publicKey, this.ss58Prefix);
            const h160Address = deriveH160(raw.publicKey);
            return {
                address,
                h160Address,
                publicKey: raw.publicKey,
                name: raw.name ?? null,
                source: "host" as const,
                getSigner: () => {
                    if (!this.accountsProvider) {
                        throw new Error("Host provider is disconnected");
                    }
                    return this.accountsProvider.getLegacyAccountSigner({
                        dotNsIdentifier: "",
                        derivationIndex: 0,
                        publicKey: raw.publicKey,
                    });
                },
            };
        });
    }
}

/**
 * Format a host-error for logging.
 *
 * host-api errors come back as `{ tag: "v1", value: <inner> }` where the
 * inner can be either another tagged enum (with its own tag/value) or a
 * plain `Error`-shaped object surfacing client-side codec failures
 * (e.g. `GenericError: inner[tag] is not a function` when the SDK
 * encodes a request the codec doesn't understand).
 *
 * Walking the value side as well as the tag means schema drift between
 * host-api versions and the SDK produces something more diagnostic than
 * just the outermost wrapper tag.
 */
function formatError(error: unknown): string {
    if (!error || typeof error !== "object") return String(error);
    const e = error as Record<string, unknown>;
    if (!("tag" in e)) return String(error);

    const outerTag = String(e.tag);
    const inner = e.value;

    // Inner is an Error-shaped object with name/message — surface those.
    if (inner && typeof inner === "object") {
        const innerObj = inner as Record<string, unknown>;
        if (typeof innerObj.message === "string") {
            const innerName =
                typeof innerObj.name === "string" && innerObj.name !== "Error"
                    ? `${innerObj.name}: `
                    : "";
            return `${outerTag} → ${innerName}${innerObj.message}`;
        }
        // Inner is a nested tagged-enum — recurse.
        if ("tag" in innerObj) {
            return `${outerTag} → ${formatError(inner)}`;
        }
    }

    // Inner is a primitive or absent — fall back to the outer tag alone.
    if (inner !== undefined) {
        return `${outerTag} (${String(inner)})`;
    }
    return outerTag;
}

if (import.meta.vitest) {
    const { test, expect, describe, vi, beforeEach } = import.meta.vitest;

    interface RawAccountTest {
        publicKey: Uint8Array;
        name?: string | undefined;
    }

    function createMockProvider(
        options: {
            accounts?: RawAccountTest[];
            shouldReject?: boolean;
            error?: unknown;
        } = {},
    ) {
        const accounts = options.accounts ?? [];
        const shouldReject = options.shouldReject ?? false;
        const mockSigner = {
            publicKey: new Uint8Array(32).fill(0xbb),
        } as unknown as import("polkadot-api").PolkadotSigner;

        return {
            getLegacyAccounts: vi.fn().mockReturnValue({
                match: async (
                    onOk: (v: RawAccountTest[]) => unknown,
                    onErr: (e: unknown) => unknown,
                ) => {
                    if (shouldReject) {
                        return onErr(options.error ?? "Unknown");
                    }
                    return onOk(accounts);
                },
            }),
            getLegacyAccountSigner: vi.fn().mockReturnValue(mockSigner),
            getProductAccount: vi.fn().mockReturnValue({
                match: async (
                    onOk: (v: RawAccountTest) => unknown,
                    onErr: (e: unknown) => unknown,
                ) => {
                    if (shouldReject) {
                        return onErr(options.error ?? "Unknown");
                    }
                    return onOk(accounts[0] ?? { publicKey: new Uint8Array(32), name: undefined });
                },
            }),
            getProductAccountSigner: vi.fn().mockReturnValue(mockSigner),
            getProductAccountAlias: vi.fn().mockReturnValue({
                match: async (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => {
                    if (shouldReject) {
                        return onErr(options.error ?? "Unknown");
                    }
                    return onOk({
                        context: new Uint8Array(32).fill(0x01),
                        alias: new Uint8Array(64).fill(0x02),
                    });
                },
            }),
            createRingVRFProof: vi.fn().mockReturnValue({
                match: async (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => {
                    if (shouldReject) {
                        return onErr(options.error ?? "Unknown");
                    }
                    return onOk(new Uint8Array(128).fill(0x03));
                },
            }),
            subscribeAccountConnectionStatus: vi.fn().mockReturnValue(() => {}),
        };
    }

    function createMockSdk(
        mockProvider: ReturnType<typeof createMockProvider>,
        opts?: {
            hostApi?: HostApiPermissionBridge;
        },
    ): ProductSdkModule {
        return {
            createAccountsProvider: () => mockProvider as unknown as AccountsProvider,
            ...(opts?.hostApi ? { hostApi: opts.hostApi } : {}),
        };
    }

    /**
     * A fake neverthrow ResultAsync-like object. Resolves via `onOk` when
     * `error === undefined`, otherwise via `onErr`.
     */
    function fakeResult<T>(value: T, error?: unknown): NeverthrowResultAsync<T, unknown> {
        return {
            match: async (onOk, onErr) => {
                if (error !== undefined) return onErr(error);
                return onOk(value);
            },
        };
    }

    const fakeHostApiEnum: HostApiEnumHelper = {
        enumValue: (version, value) => ({ version, value }),
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe("HostProvider", () => {
        test("returns HOST_UNAVAILABLE when SDK load fails", async () => {
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.reject(new Error("Cannot find module")),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(HostUnavailableError);
                expect(result.error.message).toContain("Cannot find module");
            }
        });

        test("returns HOST_REJECTED when getLegacyAccounts fails", async () => {
            const mockProvider = createMockProvider({ shouldReject: true, error: "Rejected" });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider)),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(HostRejectedError);
            }
        });

        test("returns NO_ACCOUNTS when host returns empty list", async () => {
            const mockProvider = createMockProvider({ accounts: [] });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider)),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(NoAccountsError);
            }
        });

        test("maps accounts correctly on success", async () => {
            const rawAccounts: RawAccountTest[] = [
                { publicKey: new Uint8Array(32).fill(0xaa), name: "Alice" },
                { publicKey: new Uint8Array(32).fill(0xbb), name: undefined },
            ];
            const mockProvider = createMockProvider({ accounts: rawAccounts });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider)),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toHaveLength(2);
                expect(result.value[0].name).toBe("Alice");
                expect(result.value[0].source).toBe("host");
                expect(result.value[0].publicKey).toEqual(rawAccounts[0].publicKey);
                expect(result.value[1].name).toBeNull();
            }
        });

        test("getProductAccountSigner pins signerType to 'createTransaction'", async () => {
            // Regression guard: the alternate "signPayload" route goes through
            // PJS and throws on unknown signed extensions (e.g. AsPgas on
            // Paseo Next). If a future refactor drops the explicit pin and
            // upstream's default ever flips back to signPayload, this would
            // silently regress.
            const rawAccounts: RawAccountTest[] = [
                { publicKey: new Uint8Array(32).fill(0xaa), name: "Alice" },
            ];
            const mockProvider = createMockProvider({ accounts: rawAccounts });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider)),
            });
            await provider.connect();

            // Path 1: HostProvider.getProductAccountSigner(...)
            provider.getProductAccountSigner({
                dotNsIdentifier: "test.dot",
                derivationIndex: 0,
                publicKey: rawAccounts[0].publicKey,
            });
            expect(mockProvider.getProductAccountSigner).toHaveBeenLastCalledWith(
                expect.anything(),
                "createTransaction",
            );

            // Path 2: getSigner() returned from HostProvider.getProductAccount(...)
            const productAccountResult = await provider.getProductAccount("test.dot", 0);
            expect(productAccountResult.ok).toBe(true);
            if (productAccountResult.ok) {
                productAccountResult.value.getSigner();
                expect(mockProvider.getProductAccountSigner).toHaveBeenLastCalledWith(
                    expect.anything(),
                    "createTransaction",
                );
            }
        });

        test("disconnect is idempotent", () => {
            const provider = new HostProvider();
            provider.disconnect();
            provider.disconnect();
        });

        test("type is 'host'", () => {
            const provider = new HostProvider();
            expect(provider.type).toBe("host");
        });

        test("onAccountsChange adds and removes listener", () => {
            const provider = new HostProvider();
            const cb = () => {};
            const unsub = provider.onAccountsChange(cb);
            expect(typeof unsub).toBe("function");
            unsub();
        });
    });

    describe("ChainSubmit permission request", () => {
        test("sends a v1 ChainSubmit request (regression guard for the TransactionSubmit bug)", async () => {
            const captured: unknown[] = [];
            const hostApi: HostApiPermissionBridge = {
                permission: (request) => {
                    captured.push(request);
                    return fakeResult(undefined);
                },
            };
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0x01) }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider, { hostApi })),
                loadHostApiEnum: () => Promise.resolve(fakeHostApiEnum),
            });

            await provider.connect();

            expect(captured).toHaveLength(1);
            // The fake hostApiEnum returns `{ version, value }` so we can
            // assert on the exact wire shape that would reach
            // host-api's RemotePermission codec.
            expect(captured[0]).toEqual({
                version: "v1",
                value: { tag: "ChainSubmit", value: undefined },
            });
        });

        test("does NOT send a TransactionSubmit tag (the bug)", async () => {
            const captured: unknown[] = [];
            const hostApi: HostApiPermissionBridge = {
                permission: (request) => {
                    captured.push(request);
                    return fakeResult(undefined);
                },
            };
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0x01) }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider, { hostApi })),
                loadHostApiEnum: () => Promise.resolve(fakeHostApiEnum),
            });

            await provider.connect();

            const sent = JSON.stringify(captured[0]);
            expect(sent).not.toContain("TransactionSubmit");
        });

        test("skipped when sdk.hostApi is unavailable (older product-sdk)", async () => {
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0x01) }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider /* no hostApi */)),
                loadHostApiEnum: () => Promise.resolve(fakeHostApiEnum),
            });

            const result = await provider.connect();
            // Connect should succeed even without the hostApi bridge —
            // permission is best-effort.
            expect(result.ok).toBe(true);
        });

        test("skipped when requestChainSubmitPermission is false", async () => {
            const captured: unknown[] = [];
            const hostApi: HostApiPermissionBridge = {
                permission: (request) => {
                    captured.push(request);
                    return fakeResult(undefined);
                },
            };
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0x01) }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider, { hostApi })),
                loadHostApiEnum: () => Promise.resolve(fakeHostApiEnum),
                requestChainSubmitPermission: false,
            });

            await provider.connect();
            expect(captured).toHaveLength(0);
        });

        test("deprecated requestTransactionSubmitPermission alias still controls the request", async () => {
            const captured: unknown[] = [];
            const hostApi: HostApiPermissionBridge = {
                permission: (request) => {
                    captured.push(request);
                    return fakeResult(undefined);
                },
            };
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0x01) }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider, { hostApi })),
                loadHostApiEnum: () => Promise.resolve(fakeHostApiEnum),
                // Old name; new code path should still respect it as `false`.
                requestTransactionSubmitPermission: false,
            });

            await provider.connect();
            expect(captured).toHaveLength(0);
        });

        test("connect succeeds even when permission request rejects", async () => {
            // Whatever the host says about permission, connect() should
            // still return ok — the consumer can sign later with whatever
            // permission they negotiate.
            const hostApi: HostApiPermissionBridge = {
                permission: () => fakeResult(undefined, { tag: "PermissionDenied" }),
            };
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0x01) }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider, { hostApi })),
                loadHostApiEnum: () => Promise.resolve(fakeHostApiEnum),
            });

            const result = await provider.connect();
            expect(result.ok).toBe(true);
        });

        test("connect succeeds even when the hostApiEnum loader throws (codec drift)", async () => {
            // The original bug: the v1 RemotePermission codec didn't
            // recognize the TransactionSubmit tag and threw client-side.
            // Even when something like that happens, connect() must
            // remain ok — permission is best-effort.
            const hostApi: HostApiPermissionBridge = {
                permission: () => fakeResult(undefined),
            };
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0x01) }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadSdk: () => Promise.resolve(createMockSdk(mockProvider, { hostApi })),
                loadHostApiEnum: () => Promise.reject(new Error("codec drift")),
            });

            const result = await provider.connect();
            expect(result.ok).toBe(true);
        });
    });

    describe("formatError", () => {
        // Direct unit tests for the helper. The previous implementation
        // collapsed any tagged-enum error to its outer tag — losing the
        // inner reason. The fix surfaces the inner Error-shape (name +
        // message) and recurses through nested tagged enums.

        test("returns a string for a primitive error", () => {
            expect(formatError("Rejected")).toBe("Rejected");
            expect(formatError(42)).toBe("42");
            expect(formatError(null)).toBe("null");
            expect(formatError(undefined)).toBe("undefined");
        });

        test("surfaces inner Error name + message under the outer tag", () => {
            // Simulates the exact shape the original bug produced:
            // `{ tag: "v1", value: { name: "GenericError", message: "..." } }`
            const wrapped = {
                tag: "v1",
                value: {
                    name: "GenericError",
                    message: "Unknown error: inner[tag] is not a function",
                },
            };
            const out = formatError(wrapped);
            expect(out).toContain("v1");
            expect(out).toContain("GenericError");
            expect(out).toContain("inner[tag] is not a function");
        });

        test("strips the redundant 'Error' name when the inner is a plain Error", () => {
            const wrapped = {
                tag: "v1",
                value: { name: "Error", message: "boom" },
            };
            expect(formatError(wrapped)).toBe("v1 → boom");
        });

        test("recurses through nested tagged-enum errors", () => {
            const wrapped = {
                tag: "v1",
                value: { tag: "Inner", value: { name: "NestedErr", message: "deep" } },
            };
            expect(formatError(wrapped)).toContain("v1");
            expect(formatError(wrapped)).toContain("Inner");
            expect(formatError(wrapped)).toContain("NestedErr");
            expect(formatError(wrapped)).toContain("deep");
        });

        test("returns just the outer tag when value is undefined", () => {
            expect(formatError({ tag: "PermissionDenied" })).toBe("PermissionDenied");
        });

        test("formats a primitive inner value alongside the tag", () => {
            expect(formatError({ tag: "v1", value: "code-42" })).toBe("v1 (code-42)");
        });
    });

    describe("RemotePermission codec interop", () => {
        // Smoke test that the wire payload we build (`ChainSubmit`) round-trips
        // through the real host-api codec. The previous bug shipped
        // `TransactionSubmit`, which the codec rejects — locking this in here
        // catches a regression at the codec layer without needing the host.
        test("encodes ChainSubmit payload without throwing", async () => {
            const { RemotePermission } = await import("@novasamatech/host-api");
            const payload = { tag: "ChainSubmit" as const, value: undefined };
            const encoded = RemotePermission.enc(payload);
            expect(encoded).toBeInstanceOf(Uint8Array);
            const decoded = RemotePermission.dec(encoded);
            expect(decoded.tag).toBe("ChainSubmit");
        });

        test("rejects the legacy TransactionSubmit tag", async () => {
            const { RemotePermission } = await import("@novasamatech/host-api");
            // `TransactionSubmit` is not a valid variant in v1 — the codec
            // should refuse to encode it. This proves the codec actually
            // validates tags (so test 1 isn't a tautology).
            expect(() =>
                RemotePermission.enc({
                    tag: "TransactionSubmit",
                    value: undefined,
                } as never),
            ).toThrow();
        });
    });
}
