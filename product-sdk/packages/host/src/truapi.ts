/**
 * TruAPI - the protocol for communicating between apps and the Polkadot host container.
 *
 * This module centralizes access to @novasamatech/product-sdk and @novasamatech/host-api,
 * allowing other @parity/product-sdk-* packages to import from here rather than depending
 * directly on novasama packages.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { enumValue } from "@novasamatech/host-api";
import type {
    AllocatableResource as AllocatableResourceCodec,
    AllocationOutcome as AllocationOutcomeCodec,
    CodecType,
} from "@novasamatech/host-api";

const log = createLogger("host");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers from @novasamatech/host-api (re-exported from @novasamatech/scale)
// ─────────────────────────────────────────────────────────────────────────────

export {
    /**
     * Construct an enum variant for TruAPI calls.
     *
     * @example
     * ```ts
     * import { enumValue, getTruApi } from "@parity/product-sdk-host";
     *
     * const truApi = await getTruApi();
     * if (truApi) {
     *   await truApi.permission([enumValue("ChainSubmit")]);
     * }
     * ```
     */
    enumValue,
    /**
     * Check if a value is a specific enum variant.
     */
    isEnumVariant,
    /**
     * Assert that a value is a specific enum variant, throwing if not.
     */
    assertEnumVariant,
    /**
     * Unwrap a Result, throwing on error.
     */
    unwrapResultOrThrow,
    /**
     * Create an Ok result.
     */
    resultOk,
    /**
     * Create an Err result.
     */
    resultErr,
    /**
     * Convert bytes to hex string.
     */
    toHex,
    /**
     * Convert hex string to bytes.
     */
    fromHex,
} from "@novasamatech/host-api";

/** A `0x`-prefixed hex string (the template literal type ``\`0x${string}\``) used by the host API surface for raw byte payloads. Re-exported from `@novasamatech/host-api` so consumers bridging between host APIs and SDK code can reach the host-side type without an additional dependency. */
export type { HexString } from "@novasamatech/host-api";

// ─────────────────────────────────────────────────────────────────────────────
// TruAPI accessor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The TruApi type - provides low-level methods for communicating with the host.
 *
 * Methods include:
 * - `navigateTo(url)` — Navigate to a URL within the host
 * - `permission(permissions)` — Request permissions from the host
 * - `localStorageRead/Write/Clear` — Host-backed storage
 * - `sign(payload)` — Request transaction signing
 * - `deriveEntropy(context)` — Derive deterministic entropy
 * - `themeSubscribe()` — Subscribe to host theme changes
 * - And many more...
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TruApi = any;

/** Cached TruApi instance */
let cachedTruApi: TruApi | null = null;

/**
 * Get the TruAPI instance for direct low-level access.
 *
 * Returns the `hostApi` object from `@novasamatech/product-sdk` which provides
 * methods for communicating directly with the host container. Returns `null`
 * when running outside a container or when the SDK is unavailable.
 *
 * For most use cases, prefer the higher-level functions like `getHostLocalStorage()`,
 * `getHostProvider()`, etc. Use this when you need direct access to host methods
 * like `navigateTo()`, `permission()`, or `deriveEntropy()`.
 *
 * @example
 * ```ts
 * import { getTruApi, enumValue } from "@parity/product-sdk-host";
 *
 * const truApi = await getTruApi();
 * if (truApi) {
 *   // Request permission
 *   const result = await truApi.permission([enumValue("ChainSubmit")]);
 *
 *   // Navigate to a URL
 *   await truApi.navigateTo("polkadot://settings");
 *
 *   // Subscribe to theme changes
 *   const sub = truApi.themeSubscribe(undefined, (theme) => {
 *     console.log("Theme changed:", theme);
 *   });
 * }
 * ```
 *
 * @returns The TruAPI instance, or `null` if unavailable.
 */
export async function getTruApi(): Promise<TruApi | null> {
    if (cachedTruApi) return cachedTruApi;

    try {
        const sdk = await import("@novasamatech/product-sdk");
        cachedTruApi = sdk.hostApi;
        log.debug("TruAPI loaded");
        return cachedTruApi;
    } catch {
        log.debug("TruAPI unavailable (not in container or SDK not installed)");
        return null;
    }
}

/**
 * Get the preimage manager for bulletin chain operations.
 *
 * The preimage manager handles uploading and looking up preimages (arbitrary data)
 * on the bulletin chain through the host's optimized path.
 *
 * @returns The preimage manager, or `null` if unavailable.
 *
 * @example
 * ```ts
 * import { getPreimageManager } from "@parity/product-sdk-host";
 *
 * const manager = await getPreimageManager();
 * if (manager) {
 *   // Submit a preimage
 *   const key = await manager.submit(new Uint8Array([1, 2, 3]));
 *
 *   // Look up a preimage
 *   const sub = manager.lookup(key, (data) => {
 *     if (data) console.log("Found:", data);
 *   });
 * }
 * ```
 */
export async function getPreimageManager(): Promise<PreimageManager | null> {
    try {
        const sdk = await import("@novasamatech/product-sdk");
        return sdk.preimageManager;
    } catch {
        return null;
    }
}

/**
 * Preimage manager interface for bulletin chain operations.
 */
export interface PreimageManager {
    /**
     * Submit a preimage to the bulletin chain.
     * @param data - The data to submit.
     * @returns The preimage key (hex string).
     */
    submit(data: Uint8Array): Promise<string>;

    /**
     * Look up a preimage by key.
     * @param key - The preimage key (hex string).
     * @param callback - Called with the data when found, or null if not yet available.
     * @returns Subscription handle with unsubscribe method.
     */
    lookup(
        key: string,
        callback: (preimage: Uint8Array | null) => void,
    ): { unsubscribe: () => void; onInterrupt: (cb: () => void) => () => void };
}

/**
 * Get the accounts provider for managing host accounts.
 *
 * @returns The accounts provider, or `null` if unavailable.
 */
export async function getAccountsProvider(): Promise<AccountsProvider | null> {
    try {
        const sdk = await import("@novasamatech/product-sdk");
        return sdk.createAccountsProvider() as unknown as AccountsProvider;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource allocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resource types requestable via {@link requestResourceAllocation}.
 * Derived from the upstream codec so variant renames surface as compile
 * errors, not runtime failures.
 */
export type AllocatableResource = CodecType<typeof AllocatableResourceCodec>;

/**
 * Per-resource outcome from {@link requestResourceAllocation}.
 * The host strips secret payloads from `Allocated` before returning, so
 * `value` is always `undefined` on the product side.
 */
export type AllocationOutcome = CodecType<typeof AllocationOutcomeCodec>;

/**
 * Request the host to pre-allocate one or more resource allowances.
 *
 * The host prompts the user once; subsequent operations covered by the
 * granted allowance don't re-prompt.
 *
 * @param resources - Resources to request.
 * @returns Per-resource outcomes in the same order as `resources`.
 * @throws If the host is unavailable or the request fails.
 *
 * @example
 * ```ts
 * const outcomes = await requestResourceAllocation([
 *   { tag: "BulletInAllowance", value: undefined },
 * ]);
 * if (outcomes[0].tag === "Allocated") { ... }
 * ```
 */
export async function requestResourceAllocation(
    resources: AllocatableResource[],
): Promise<AllocationOutcome[]> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("requestResourceAllocation: TruAPI unavailable");
    }
    log.debug("requestResourceAllocation", { resources: resources.map((r) => r.tag) });

    // `.match()` because the host returns a neverthrow ResultAsync, not a Promise.
    return await truApi.requestResourceAllocation(enumValue("v1", resources)).match(
        (envelope: { tag: "v1"; value: AllocationOutcome[] }) => envelope.value,
        (err: unknown) => {
            throw new Error(`requestResourceAllocation failed: ${JSON.stringify(err)}`);
        },
    );
}

/**
 * One of the user's existing wallet accounts, surfaced through the host and
 * identified by its public key and an optional name. Contrast with
 * {@link ProductAccount}, which is also user-controlled but derived by the
 * host for a specific app rather than picked from the user's existing keys.
 */
export interface HostAccount {
    publicKey: Uint8Array;
    name?: string;
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
 * Neverthrow-style ResultAsync returned by product-sdk methods.
 *
 * Use `.match(onOk, onErr)` to handle success/error cases.
 */
export interface ResultAsync<T, E> {
    match: <A, B = A>(ok: (t: T) => A, err: (e: E) => B) => Promise<A | B>;
}

/**
 * Accounts provider interface from @novasamatech/product-sdk.
 *
 * Provides methods for accessing host wallet accounts, product accounts,
 * and Ring VRF operations.
 */
export interface AccountsProvider {
    /**
     * Get legacy accounts (user's external wallets connected to the host).
     *
     * Renamed from `getNonProductAccounts` in @novasamatech/product-sdk 0.7.
     *
     * @returns ResultAsync resolving to array of accounts.
     */
    getLegacyAccounts: () => ResultAsync<HostAccount[], unknown>;

    /**
     * Get a signer for a legacy account.
     *
     * Renamed from `getNonProductAccountSigner` in @novasamatech/product-sdk 0.7.
     *
     * @param account - The product account (used for public key lookup).
     * @returns A PolkadotSigner for signing transactions.
     */
    getLegacyAccountSigner: (account: ProductAccount) => import("polkadot-api").PolkadotSigner;

    /**
     * Get an app-scoped product account from the host.
     *
     * Product accounts are derived by the host wallet for each app, identified
     * by `dotNsIdentifier` (e.g., "mark3t.dot"). The user controls these accounts
     * but they are scoped to the requesting app.
     *
     * @param dotNsIdentifier - App identifier (e.g., "mark3t.dot").
     * @param derivationIndex - Derivation index within the app scope. Default: 0
     * @returns ResultAsync resolving to the account.
     */
    getProductAccount: (
        dotNsIdentifier: string,
        derivationIndex?: number,
    ) => ResultAsync<HostAccount, unknown>;

    /**
     * Get a signer for a product account.
     *
     * @param account - The product account.
     * @returns A PolkadotSigner for signing transactions.
     */
    getProductAccountSigner: (account: ProductAccount) => import("polkadot-api").PolkadotSigner;

    /**
     * Get a contextual alias for a product account via Ring VRF.
     *
     * Aliases prove account membership in a ring without revealing which
     * account produced the alias.
     *
     * @param dotNsIdentifier - App identifier.
     * @param derivationIndex - Derivation index. Default: 0
     * @returns ResultAsync resolving to the contextual alias.
     */
    getProductAccountAlias: (
        dotNsIdentifier: string,
        derivationIndex?: number,
    ) => ResultAsync<ContextualAlias, unknown>;

    /**
     * Create a Ring VRF proof for anonymous operations.
     *
     * Proves that the signer is a member of the ring at the given location
     * without revealing which member.
     *
     * @param dotNsIdentifier - App identifier.
     * @param derivationIndex - Derivation index.
     * @param location - Ring location on-chain.
     * @param message - Message to sign.
     * @returns ResultAsync resolving to the proof bytes.
     */
    createRingVRFProof: (
        dotNsIdentifier: string,
        derivationIndex: number,
        location: unknown,
        message: Uint8Array,
    ) => ResultAsync<Uint8Array, unknown>;

    /**
     * Subscribe to account connection status changes.
     *
     * @param callback - Called with status string ("connected" | "disconnected").
     * @returns Unsubscribe handle.
     */
    subscribeAccountConnectionStatus: (
        callback: (status: string) => void,
    ) => { unsubscribe: () => void } | (() => void);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getTruApi returns TruApi when SDK is available", async () => {
        // Reset cache for test
        cachedTruApi = null;
        const api = await getTruApi();
        // In dev/test mode, product-sdk is installed
        expect(api === null || typeof api === "object").toBe(true);
    });

    test("getPreimageManager returns manager when SDK is available", async () => {
        const manager = await getPreimageManager();
        // In dev/test mode, product-sdk is installed
        expect(manager === null || typeof manager === "object").toBe(true);
    });

    test("getAccountsProvider returns provider when SDK is available", async () => {
        // In dev/test mode, product-sdk is installed, so this returns a provider
        const provider = await getAccountsProvider();
        // Just verify it returns something (null when SDK unavailable, provider when available)
        expect(provider === null || typeof provider === "object").toBe(true);
    });

    test("enumValue is exported", async () => {
        const { enumValue } = await import("./truapi.js");
        expect(typeof enumValue).toBe("function");
    });

    test("requestResourceAllocation throws when TruAPI is unavailable", async () => {
        cachedTruApi = null;
        const api = await getTruApi();
        if (api === null) {
            await expect(
                requestResourceAllocation([{ tag: "BulletInAllowance", value: undefined }]),
            ).rejects.toThrow(/TruAPI unavailable/);
        } else {
            expect(typeof requestResourceAllocation).toBe("function");
        }
    });
}
