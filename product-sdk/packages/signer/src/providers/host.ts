// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { deriveH160, ss58Encode } from "@parity/product-sdk-address";
import {
    getAccountsProvider,
    type RemotePermission,
    requestPermission,
} from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";

import { HostRejectedError, HostUnavailableError, type SignerError } from "../errors.js";
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
     * Dapp identifier the SDK falls back to when {@link productAccount} is
     * not set, so `connect()` can still surface a usable account on hosts
     * that don't enumerate legacy accounts.
     *
     * The value is treated as a dotNS identifier (`.dot` is appended if
     * missing) and routed through `getProductAccount(dappName, 0)`. If the
     * host rejects the derivation (e.g. the identifier isn't registered),
     * `connect()` resolves with an empty accounts list rather than
     * throwing — consumers can still drive the explicit signing paths
     * (`signMessageWithDotNsIdentity`, `getLegacyAccountSigner`).
     *
     * Wired through from `SignerManager` automatically; only set directly
     * when instantiating `HostProvider` outside the manager.
     */
    dappName?: string;
    /**
     * Custom accounts-provider loader. Defaults to `@parity/product-sdk-host`'s
     * `getAccountsProvider`, which returns `null` outside a host container.
     * Override for testing or custom host setups.
     * @internal
     */
    loadAccountsProvider?: () => Promise<AccountsProvider | null>;
    /**
     * Custom `ChainSubmit` permission requester. Defaults to a thin adapter over
     * `@parity/product-sdk-host`'s `requestPermission` that unwraps its `Result`
     * (throwing the typed error on the `err` channel). Override for testing.
     * @internal
     */
    requestChainSubmitPermissionFn?: (permission: RemotePermission) => Promise<boolean>;
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
    /**
     * If set, `connect()` returns a single product account for the given
     * `dotNsIdentifier`, skipping the legacy fetch entirely. For apps
     * that sign exclusively with a per-dapp derived account.
     *
     * Signing goes through the host's `createTransaction` path (see PR #96).
     */
    productAccount?: {
        /** App identifier (e.g., `"playground.dot"`). */
        dotNsIdentifier: string;
        /** Derivation index within the app scope. Default: 0. */
        derivationIndex?: number;
        /**
         * Populate `SignerAccount.name` best-effort from
         * `accounts.getUserId().primaryUsername`.
         *
         * On by default. Set to `false` to skip the fetch: `getUserId`
         * triggers a host identity-permission prompt, so apps that don't
         * render the user's name (those with their own display chain, e.g.
         * registry username → fallback) can opt out and avoid the prompt.
         * When enabled and the fetch fails (NotConnected, PermissionDenied,
         * codec drift) the name stays null and connect still succeeds. The
         * name can also be fetched later on demand via
         * {@link HostProvider.getUserId}. Default: `true`.
         */
        requestName?: boolean;
    };
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
 * Location of a Ring VRF ring on-chain: the hosting chain's genesis hash plus
 * the junction path addressing the ring within it.
 *
 * Matches the product-sdk's `RingLocation` codec shape.
 */
export interface RingLocation {
    /** Genesis hash of the chain hosting the ring. */
    chainId: string;
    /** Path addressing the ring within the chain. */
    junctions: Array<
        { tag: "PalletInstance"; value: number } | { tag: "CollectionId"; value: string }
    >;
}

/**
 * A product-scoped proof context, hashed by the host into the 32-byte context
 * a proof or alias is bound to.
 *
 * Matches the product-sdk's `ProductProofContext` codec shape.
 */
export interface ProductProofContext {
    /** dotNS product identifier (e.g. "my-product.dot") scoping the context. */
    productId: string;
    /** Hex-encoded suffix distinguishing contexts within the product. */
    suffix: string;
}

/**
 * A Ring VRF proof plus the values needed to verify it downstream.
 *
 * Matches the product-sdk's decoded proof shape.
 */
export interface RingVRFProof {
    /** Raw ring VRF proof bytes. */
    proof: Uint8Array;
    /** Alias derived for the request's context. */
    contextualAlias: ContextualAlias;
    /** Index of the selected member key within the ring. */
    ringIndex: number;
    /** Ring revision the proof was generated against. */
    ringRevision: number;
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

/** @internal */
export interface AccountsProvider {
    getLegacyAccounts: () => NeverthrowResultAsync<RawAccount[], unknown>;
    getLegacyAccountSigner: (account: {
        publicKey: Uint8Array;
    }) => import("polkadot-api").PolkadotSigner;
    getProductAccount: (
        dotNsIdentifier: string,
        derivationIndex?: number,
    ) => NeverthrowResultAsync<RawAccount, unknown>;
    getProductAccountSigner: (account: ProductAccount) => import("polkadot-api").PolkadotSigner;
    getProductAccountAlias: (
        context: ProductProofContext,
        location: RingLocation,
    ) => NeverthrowResultAsync<ContextualAlias, unknown>;
    getUserId: () => NeverthrowResultAsync<{ primaryUsername: string }, unknown>;
    createRingVRFProof: (
        context: ProductProofContext,
        location: RingLocation,
        message: Uint8Array,
    ) => NeverthrowResultAsync<RingVRFProof, unknown>;
    subscribeAccountConnectionStatus: (
        callback: (status: string) => void,
    ) => { unsubscribe: () => void } | (() => void);
}

/* @integration */
async function defaultLoadAccountsProvider(): Promise<AccountsProvider | null> {
    // `@parity/product-sdk-host`'s provider is structurally compatible with the
    // (looser) shape declared above; the cast bridges the nominal gap.
    return (await getAccountsProvider()) as unknown as AccountsProvider | null;
}

/**
 * Default `requestChainSubmitPermissionFn`: bridge host's `Result`-returning
 * {@link requestPermission} back to the option's `Promise<boolean>` contract by
 * throwing the typed `HostError` on the `err` channel. The throw is caught
 * (and warned, not fatal) at the connect-time call site.
 */
async function defaultRequestChainSubmitPermission(permission: RemotePermission): Promise<boolean> {
    const result = await requestPermission(permission);
    if (!result.ok) throw result.error;
    return result.value;
}

/**
 * Provider for the Host API (Polkadot Desktop / Android).
 *
 * Backed by `@parity/product-sdk-host`'s `getAccountsProvider`, which talks to
 * the host over `@parity/truapi`. Apps running outside a host container — e.g.
 * a plain browser tab during `npm run dev` — get a `HOST_UNAVAILABLE` error
 * (the provider resolves to `null`) with actionable guidance, surfaced before
 * any host RPC call.
 *
 * Supports both non-product accounts (user's external wallets) and product
 * accounts (app-scoped derived accounts managed by the host).
 */
export class HostProvider implements SignerProvider {
    readonly type: ProviderType = "host";
    private readonly ss58Prefix: number;
    private readonly maxRetries: number;
    private readonly retryDelay: number;
    private readonly loadAccountsProvider: () => Promise<AccountsProvider | null>;
    private readonly requestChainSubmitPermissionFn: (
        permission: RemotePermission,
    ) => Promise<boolean>;
    private readonly requestChainSubmitPermission: boolean;
    private readonly productAccount: HostProviderOptions["productAccount"];
    private readonly dappName: string | undefined;

    private accountsProvider: AccountsProvider | null = null;
    private statusCleanup: (() => void) | null = null;
    private statusListeners = new Set<(status: ConnectionStatus) => void>();
    private accountListeners = new Set<(accounts: SignerAccount[]) => void>();

    constructor(options?: HostProviderOptions) {
        this.ss58Prefix = options?.ss58Prefix ?? 42;
        this.maxRetries = options?.maxRetries ?? 3;
        this.retryDelay = options?.retryDelay ?? 500;
        this.loadAccountsProvider = options?.loadAccountsProvider ?? defaultLoadAccountsProvider;
        this.requestChainSubmitPermissionFn =
            options?.requestChainSubmitPermissionFn ?? defaultRequestChainSubmitPermission;
        // New name takes precedence; fall back to the deprecated alias.
        this.requestChainSubmitPermission =
            options?.requestChainSubmitPermission ??
            options?.requestTransactionSubmitPermission ??
            true;
        this.productAccount = options?.productAccount;
        this.dappName = options?.dappName;
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
                    return this.accountsProvider.getProductAccountSigner(productAccount);
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
     * Signing routes through the host's `createTransaction` path, so unknown
     * signed extensions (e.g. `AsPgas` on Paseo Next) are forwarded to the host
     * as opaque bytes for metadata-driven decoding.
     */
    getProductAccountSigner(account: ProductAccount): import("polkadot-api").PolkadotSigner {
        if (!this.accountsProvider) {
            throw new Error("Host provider is not connected");
        }
        return this.accountsProvider.getProductAccountSigner(account);
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
        context: ProductProofContext,
        location: RingLocation,
    ): Promise<Result<ContextualAlias, SignerError>> {
        if (!this.accountsProvider) {
            return err(new HostUnavailableError("Host provider is not connected"));
        }

        try {
            const alias = (await this.accountsProvider
                .getProductAccountAlias(context, location)
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
     * Fetch the connected user's primary username from the host.
     *
     * Use this to retrieve the name lazily — e.g. on a profile screen that
     * actually displays it — when `connect()` ran without
     * `productAccount.requestName` (the default) and so never fetched it.
     * Like the connect-time fetch this triggers a host identity-permission
     * prompt; unlike it, the result is returned as a structured `Result` so
     * callers can react to a `PermissionDenied` / `NotConnected` rejection
     * explicitly instead of silently falling back to a nameless account.
     *
     * Requires a prior successful `connect()` call.
     */
    async getUserId(): Promise<Result<{ primaryUsername: string }, SignerError>> {
        if (!this.accountsProvider) {
            return err(new HostUnavailableError("Host provider is not connected"));
        }

        try {
            const result = (await this.accountsProvider.getUserId().match(
                (value) => value,
                (error) => {
                    throw new Error(`Host rejected user id request: ${formatError(error)}`);
                },
            )) as { primaryUsername: string };

            return ok(result);
        } catch (cause) {
            log.error("failed to get user id", { cause });
            return err(
                new HostRejectedError(
                    cause instanceof Error ? cause.message : "Failed to get user id",
                ),
            );
        }
    }

    /**
     * Create a Ring VRF proof for anonymous operations.
     *
     * Proves that a member of the ring at the given location produced the
     * proof without revealing which member — the host selects the member key.
     * Returns the proof plus its verification values ({@link RingVRFProof}).
     *
     * Requires a prior successful `connect()` call.
     */
    async createRingVRFProof(
        context: ProductProofContext,
        location: RingLocation,
        message: Uint8Array,
    ): Promise<Result<RingVRFProof, SignerError>> {
        if (!this.accountsProvider) {
            return err(new HostUnavailableError("Host provider is not connected"));
        }

        try {
            const proof = (await this.accountsProvider
                .createRingVRFProof(context, location, message)
                .match(
                    (result) => result,
                    (error) => {
                        throw new Error(
                            `Host rejected Ring VRF proof request: ${formatError(error)}`,
                        );
                    },
                )) as RingVRFProof;

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
        // Step 1: Obtain the host accounts provider. `null` (or a thrown error)
        // means we're not inside a host container.
        let provider: AccountsProvider | null;
        try {
            provider = await this.loadAccountsProvider();
        } catch (cause) {
            log.warn("host accounts provider unavailable", { cause });
            return err(
                new HostUnavailableError(
                    cause instanceof Error
                        ? `host accounts provider failed: ${cause.message}`
                        : "host accounts provider is unavailable",
                ),
            );
        }

        // Step 2: Verify we're actually running inside a host container.
        //
        // `getAccountsProvider()` resolves to `null` when the app isn't loaded
        // inside a Polkadot host container (e.g. a plain browser tab during
        // `npm run dev`, with no iframe under Polkadot Desktop or WebView under
        // Polkadot Mobile). Returning `HostUnavailableError` here — before any
        // host RPC call — matches the TSDoc contract ("Apps running outside a
        // host container will gracefully get a HOST_UNAVAILABLE error") and
        // gives consumers actionable guidance, rather than letting a later RPC
        // surface a misleading rejection.
        if (!provider) {
            log.warn("not inside a host container — Host API unavailable");
            return err(
                new HostUnavailableError(
                    "Host API is not available: not running inside a Polkadot host container. " +
                        "Open this app inside Polkadot Desktop or the Polkadot Mobile WebView, " +
                        "or pick a non-host signer provider (e.g. dev accounts).",
                ),
            );
        }
        this.accountsProvider = provider;

        // Step 3: Fetch accounts.
        //
        // Both branches end in `fetchProductSignerAccount`. The difference
        // is only where the dotNS identifier comes from:
        //  - explicit `productAccount` option (caller-supplied), OR
        //  - implicit derivation from `dappName` (the SDK-managed default
        //    for hosts that don't enumerate accounts, e.g. Polkadot Desktop).
        //
        // On hosts that don't enumerate accounts (PoP / product-account
        // hosts), `getLegacyAccounts()` returns `[]` by design — the host
        // exposes only per-dapp product accounts and never the user's
        // identity account. The implicit derivation path matches that
        // contract: derive the per-dapp account using the consumer's
        // `dappName` as the identifier, surface it on `connect()`. When
        // the host rejects the derivation (typically because the dapp's
        // dotNS identifier isn't registered for this user), we resolve
        // with an empty accounts list rather than throwing so consumers
        // can still drive the explicit-name signing paths
        // (`signMessageWithDotNsIdentity`, `getLegacyAccountSigner`).
        let signerAccounts: SignerAccount[];
        if (this.productAccount) {
            const accountResult = await this.fetchProductSignerAccount(
                provider,
                this.productAccount.dotNsIdentifier,
                this.productAccount.derivationIndex ?? 0,
                this.productAccount.requestName ?? true,
            );
            if (!accountResult.ok) return accountResult;
            signerAccounts = [accountResult.value];
        } else if (this.dappName) {
            // `.dot` is appended if missing so `"my-app"` and `"my-app.dot"`
            // resolve to the same identifier on the host side.
            const dotNsIdentifier = this.dappName.endsWith(".dot")
                ? this.dappName
                : `${this.dappName}.dot`;
            const accountResult = await this.fetchProductSignerAccount(
                provider,
                dotNsIdentifier,
                0,
                true,
            );
            if (!accountResult.ok) {
                // Soft-degrade: host couldn't derive a product account for
                // this dappName (most commonly because the identifier isn't
                // registered for this user). Returning [] lets `connect()`
                // resolve successfully — consumers handle the empty list
                // and drive explicit signing paths.
                log.warn(
                    "host could not derive a product account for dappName; resolving with empty accounts",
                    {
                        dotNsIdentifier,
                        error: accountResult.error.message,
                    },
                );
                signerAccounts = [];
            } else {
                signerAccounts = [accountResult.value];
            }
        } else {
            // No `productAccount`, no `dappName` — caller asked the SDK to
            // pick accounts with no hints. We can't, so resolve with an
            // empty list. Consumers driving explicit-name signing still
            // work; consumers expecting enumeration get a clear `[]`.
            log.warn(
                "no productAccount or dappName configured; resolving connect() with empty accounts",
            );
            signerAccounts = [];
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
        if (this.requestChainSubmitPermission) {
            try {
                const granted = await this.requestChainSubmitPermissionFn({
                    tag: "ChainSubmit",
                    value: undefined,
                });
                log.debug("ChainSubmit permission result", { granted });
            } catch (cause) {
                log.warn("failed to request ChainSubmit permission", { cause });
            }
        }

        log.info("host connected", { accounts: signerAccounts.length });

        // Step 5: Subscribe to connection status. The host reports a string
        // union (`"Connected"` / `"Disconnected"`); match case-insensitively.
        const sub = provider.subscribeAccountConnectionStatus((status) => {
            const mapped: ConnectionStatus =
                String(status).toLowerCase() === "connected" ? "connected" : "disconnected";
            log.debug("host status changed", { status: mapped });
            for (const listener of this.statusListeners) {
                listener(mapped);
            }
        });
        this.statusCleanup = typeof sub === "function" ? sub : () => sub.unsubscribe();

        return ok(signerAccounts);
    }

    private async fetchProductSignerAccount(
        provider: AccountsProvider,
        dotNsIdentifier: string,
        derivationIndex: number,
        requestName: boolean,
    ): Promise<Result<SignerAccount, SignerError>> {
        // The name fetch is on by default; `requestName: false` opts out.
        // `getUserId` triggers a host identity-permission prompt, so apps
        // that don't render the user's name can skip it. When enabled it
        // runs in parallel with the account fetch — they're independent host
        // RPCs — and its failures (NotConnected, PermissionDenied, codec
        // drift) resolve to `null` so they never abort connect; the account
        // name then falls back to whatever `getProductAccount` returned
        // (typically also null, since product accounts are nameless on the
        // host side).
        const fetchUsername = async (): Promise<string | null> => {
            if (!requestName) return null;
            try {
                return await provider.getUserId().match(
                    (result) => result.primaryUsername,
                    (error) => {
                        log.debug("getUserId failed; product account name stays null", {
                            error: formatError(error),
                        });
                        return null as string | null;
                    },
                );
            } catch (cause) {
                log.debug("getUserId threw; product account name stays null", { cause });
                return null;
            }
        };
        const [accountResult, primaryUsername] = await Promise.all([
            this.getProductAccount(dotNsIdentifier, derivationIndex),
            fetchUsername(),
        ]);
        if (!accountResult.ok) return accountResult;
        const account = accountResult.value;
        return ok({ ...account, name: account.name ?? primaryUsername });
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
    // truapi GenericError is { reason } with no `tag`.
    if (!("tag" in e)) {
        if (typeof e.reason === "string") return e.reason;
        if (typeof e.message === "string") return e.message;
        return String(error);
    }

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
            primaryUsername?: string;
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
                    return onOk({
                        proof: new Uint8Array(128).fill(0x03),
                        contextualAlias: {
                            context: new Uint8Array(32).fill(0x01),
                            alias: new Uint8Array(64).fill(0x02),
                        },
                        ringIndex: 0,
                        ringRevision: 0,
                    });
                },
            }),
            subscribeAccountConnectionStatus: vi.fn().mockReturnValue(() => {}),
            getUserId: vi.fn().mockReturnValue({
                match: async (
                    onOk: (v: { primaryUsername: string }) => unknown,
                    onErr: (e: unknown) => unknown,
                ) => {
                    if (shouldReject) {
                        return onErr(options.error ?? "Unknown");
                    }
                    return onOk({ primaryUsername: options.primaryUsername ?? "" });
                },
            }),
        };
    }

    /** Wrap a mock accounts provider as the loader the HostProvider expects. */
    function loadProvider(mockProvider: ReturnType<typeof createMockProvider>) {
        return () => Promise.resolve(mockProvider as unknown as AccountsProvider);
    }

    /** A permission requester spy that always grants, unless overridden. */
    function grantPermission() {
        return vi.fn<(permission: RemotePermission) => Promise<boolean>>().mockResolvedValue(true);
    }

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe("HostProvider", () => {
        test("returns HOST_UNAVAILABLE when the accounts-provider loader throws", async () => {
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: () => Promise.reject(new Error("boom")),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(HostUnavailableError);
                expect(result.error.message).toContain("boom");
            }
        });

        test("returns HOST_UNAVAILABLE when not inside a host container (provider null)", async () => {
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: () => Promise.resolve(null),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(HostUnavailableError);
            }
        });

        test("returns HOST_UNAVAILABLE with actionable guidance when not inside a host container", async () => {
            // Outside a host container `getAccountsProvider()` resolves to null;
            // connect() returns a HostUnavailableError naming the host container
            // and pointing the user at the fix path — without making any host
            // RPC call. (Repro for playground-cli#4: `npm run dev` opens
            // localhost in a plain browser tab — no iframe, no WebView.)
            const mockProvider = createMockProvider({ accounts: [] });
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: () => Promise.resolve(null),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(HostUnavailableError);
                expect(result.error.message).toMatch(
                    /not running inside a Polkadot host container/i,
                );
                expect(result.error.message).toMatch(/Polkadot Desktop|Polkadot Mobile/i);
            }
            // We never reached `getLegacyAccounts()` — proves the env check
            // short-circuits before any RPC call, so users in a dev browser
            // never see the upstream exception text leak through.
            expect(mockProvider.getLegacyAccounts).not.toHaveBeenCalled();
        });

        test("connect with dappName fallback derives a product account", async () => {
            // Without an explicit `productAccount`, the SDK derives the
            // dotNS identifier from `dappName` (with `.dot` appended if
            // missing). This is the path hosts that don't enumerate
            // accounts (PoP / Polkadot Desktop) take by default.
            const productPubkey = new Uint8Array(32).fill(0x42);
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: productPubkey, name: undefined }],
                primaryUsername: "alice",
            });
            const provider = new HostProvider({
                maxRetries: 1,
                dappName: "my-cli",
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toHaveLength(1);
                expect(result.value[0].publicKey).toEqual(productPubkey);
                expect(result.value[0].source).toBe("host");
            }
            // `.dot` appended automatically.
            expect(mockProvider.getProductAccount).toHaveBeenCalledWith("my-cli.dot", 0);
        });

        test("connect with dappName already ending in .dot doesn't double-append", async () => {
            const productPubkey = new Uint8Array(32).fill(0x77);
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: productPubkey, name: undefined }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                dappName: "my-cli.dot",
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            expect(mockProvider.getProductAccount).toHaveBeenCalledWith("my-cli.dot", 0);
        });

        test("connect succeeds when the default ChainSubmit permission request fails", async () => {
            // No `requestChainSubmitPermissionFn` override → the default adapter
            // (`defaultRequestChainSubmitPermission`) calls host's real
            // `requestPermission`, which returns `err` outside a container. The
            // adapter unwraps that and throws; the connect step catches it
            // (warn, non-fatal — see Step 4) so `connect()` still resolves.
            const productPubkey = new Uint8Array(32).fill(0x55);
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: productPubkey, name: undefined }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                dappName: "my-cli",
                loadAccountsProvider: loadProvider(mockProvider),
                // requestChainSubmitPermission defaults to true; no Fn override.
            });

            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toHaveLength(1);
            }
        });

        test("connect with dappName fallback resolves to [] when host rejects derivation", async () => {
            // Soft-degrade: when the host can't derive a product account
            // for the dappName (commonly because the dotNS identifier isn't
            // registered for this user), connect() returns ok([]) rather
            // than throwing. Consumers handle the empty list and drive
            // explicit signing paths.
            const mockProvider = createMockProvider({ shouldReject: true, error: "Rejected" });
            const provider = new HostProvider({
                maxRetries: 1,
                dappName: "not-registered",
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toEqual([]);
            }
        });

        test("connect resolves to [] when neither productAccount nor dappName is set", async () => {
            // Caller asked us to pick accounts with no hints. We can't, so
            // resolve with an empty list rather than throwing.
            const mockProvider = createMockProvider({});
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toEqual([]);
            }
        });

        test("getProductAccountSigner delegates to the host accounts provider", async () => {
            // The host accounts provider's getProductAccountSigner has a single
            // signing path (the host's `createTransaction`, which forwards opaque
            // signed extensions like AsPgas on Paseo Next). There is no PJS
            // fallback to select, so it's called with just the account.
            const rawAccounts: RawAccountTest[] = [
                { publicKey: new Uint8Array(32).fill(0xaa), name: "Alice" },
            ];
            const mockProvider = createMockProvider({ accounts: rawAccounts });
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
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
            );

            // Path 2: getSigner() returned from HostProvider.getProductAccount(...)
            const productAccountResult = await provider.getProductAccount("test.dot", 0);
            expect(productAccountResult.ok).toBe(true);
            if (productAccountResult.ok) {
                productAccountResult.value.getSigner();
                expect(mockProvider.getProductAccountSigner).toHaveBeenLastCalledWith(
                    expect.anything(),
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

        test("productAccount populates name via getUserId by default and skips the legacy fetch", async () => {
            const productPubkey = new Uint8Array(32).fill(0xcc);
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: productPubkey, name: undefined }],
                primaryUsername: "alice",
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
                productAccount: { dotNsIdentifier: "myapp.dot", derivationIndex: 0 },
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toHaveLength(1);
                expect(result.value[0].publicKey).toEqual(productPubkey);
                expect(result.value[0].source).toBe("host");
                expect(result.value[0].name).toBe("alice");
                result.value[0].getSigner();
                expect(mockProvider.getProductAccountSigner).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        dotNsIdentifier: "myapp.dot",
                        derivationIndex: 0,
                    }),
                );
            }
            expect(mockProvider.getProductAccount).toHaveBeenCalledWith("myapp.dot", 0);
            expect(mockProvider.getUserId).toHaveBeenCalled();
            expect(mockProvider.getLegacyAccounts).not.toHaveBeenCalled();
        });

        test("productAccount with requestName:false skips getUserId (no identity prompt) and leaves name null", async () => {
            // Opt-out: `getUserId` triggers a host identity-permission prompt,
            // so apps that don't render the name set `requestName: false`.
            const productPubkey = new Uint8Array(32).fill(0xab);
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: productPubkey, name: undefined }],
                primaryUsername: "alice",
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
                productAccount: { dotNsIdentifier: "myapp.dot", requestName: false },
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toHaveLength(1);
                expect(result.value[0].publicKey).toEqual(productPubkey);
                expect(result.value[0].name).toBeNull();
            }
            expect(mockProvider.getProductAccount).toHaveBeenCalledWith("myapp.dot", 0);
            expect(mockProvider.getUserId).not.toHaveBeenCalled();
            expect(mockProvider.getLegacyAccounts).not.toHaveBeenCalled();
        });

        test("productAccount survives getUserId failure (name stays null, connect still succeeds)", async () => {
            const productPubkey = new Uint8Array(32).fill(0xee);
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: productPubkey, name: undefined }],
            });
            // Force getUserId to reject — connect must still succeed with name=null.
            mockProvider.getUserId.mockReturnValue({
                match: async (
                    _onOk: (v: { primaryUsername: string }) => unknown,
                    onErr: (e: unknown) => unknown,
                ) => onErr({ tag: "PermissionDenied" }),
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
                productAccount: { dotNsIdentifier: "myapp.dot" },
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value[0].name).toBeNull();
            }
        });

        test("getUserId() retrieves the primary username after a connect that opted out of the name fetch", async () => {
            // The escape hatch for `requestName: false`: connect without the
            // prompt (name=null), then fetch the name lazily later — e.g. when
            // a profile screen needs to display it.
            const productPubkey = new Uint8Array(32).fill(0xa1);
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: productPubkey, name: undefined }],
                primaryUsername: "alice",
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
                productAccount: { dotNsIdentifier: "myapp.dot", requestName: false },
            });
            const connectResult = await provider.connect();
            expect(connectResult.ok).toBe(true);
            if (connectResult.ok) expect(connectResult.value[0].name).toBeNull();
            // Not fetched during connect...
            expect(mockProvider.getUserId).not.toHaveBeenCalled();

            // ...but reachable on demand afterwards.
            const userId = await provider.getUserId();
            expect(userId.ok).toBe(true);
            if (userId.ok) expect(userId.value.primaryUsername).toBe("alice");
            expect(mockProvider.getUserId).toHaveBeenCalledTimes(1);
        });

        test("getUserId() returns HostUnavailableError before connect", async () => {
            const provider = new HostProvider({ maxRetries: 1 });
            const result = await provider.getUserId();
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBeInstanceOf(HostUnavailableError);
        });

        test("getUserId() surfaces a host rejection as HostRejectedError", async () => {
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0xa2), name: undefined }],
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
                productAccount: { dotNsIdentifier: "myapp.dot", requestName: false },
            });
            await provider.connect();
            // After connect, force the host to reject the on-demand fetch.
            mockProvider.getUserId.mockReturnValue({
                match: async (
                    _onOk: (v: { primaryUsername: string }) => unknown,
                    onErr: (e: unknown) => unknown,
                ) => onErr({ tag: "v1", value: { tag: "GetUserIdErr::PermissionDenied" } }),
            });
            const result = await provider.getUserId();
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBeInstanceOf(HostRejectedError);
        });

        test("productAccount option succeeds when host has no legacy accounts (regression: signer 0.5.0 NoAccountsError)", async () => {
            // Without the option, this scenario returned `err(NoAccountsError)`
            // before any product-account fetch could happen — breaking every
            // product-only app whose host doesn't surface legacy accounts.
            const productPubkey = new Uint8Array(32).fill(0xdd);
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: productPubkey, name: undefined }],
            });
            // Force the legacy path to look empty if it were ever consulted.
            mockProvider.getLegacyAccounts.mockReturnValue({
                match: async (
                    onOk: (v: RawAccountTest[]) => unknown,
                    _onErr: (e: unknown) => unknown,
                ) => onOk([]),
            });
            const provider = new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn: grantPermission(),
                productAccount: { dotNsIdentifier: "playground.dot" },
            });
            const result = await provider.connect();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toHaveLength(1);
                expect(result.value[0].publicKey).toEqual(productPubkey);
            }
        });
    });

    describe("ChainSubmit permission request", () => {
        function providerWithPermission(
            requestChainSubmitPermissionFn: (permission: RemotePermission) => Promise<boolean>,
            extra?: Partial<HostProviderOptions>,
        ) {
            const mockProvider = createMockProvider({
                accounts: [{ publicKey: new Uint8Array(32).fill(0x01) }],
            });
            return new HostProvider({
                maxRetries: 1,
                loadAccountsProvider: loadProvider(mockProvider),
                requestChainSubmitPermissionFn,
                ...extra,
            });
        }

        test("requests the ChainSubmit permission on connect", async () => {
            const requestFn = grantPermission();
            await providerWithPermission(requestFn).connect();

            expect(requestFn).toHaveBeenCalledTimes(1);
            expect(requestFn).toHaveBeenCalledWith({ tag: "ChainSubmit", value: undefined });
        });

        test("skipped when requestChainSubmitPermission is false", async () => {
            const requestFn = grantPermission();
            await providerWithPermission(requestFn, {
                requestChainSubmitPermission: false,
            }).connect();
            expect(requestFn).not.toHaveBeenCalled();
        });

        test("deprecated requestTransactionSubmitPermission alias still controls the request", async () => {
            const requestFn = grantPermission();
            await providerWithPermission(requestFn, {
                requestTransactionSubmitPermission: false,
            }).connect();
            expect(requestFn).not.toHaveBeenCalled();
        });

        test("connect succeeds even when the permission is denied", async () => {
            const requestFn = vi
                .fn<(permission: RemotePermission) => Promise<boolean>>()
                .mockResolvedValue(false);
            const result = await providerWithPermission(requestFn).connect();
            expect(result.ok).toBe(true);
        });

        test("connect succeeds even when the permission request throws", async () => {
            const requestFn = vi
                .fn<(permission: RemotePermission) => Promise<boolean>>()
                .mockRejectedValue(new Error("host unreachable"));
            const result = await providerWithPermission(requestFn).connect();
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

        test("surfaces GenericError.reason when there is no tag", () => {
            expect(formatError({ reason: "boom" })).toContain("boom");
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
}
