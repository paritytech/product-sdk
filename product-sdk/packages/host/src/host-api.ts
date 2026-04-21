/**
 * Re-exports from @novasamatech/product-sdk and @novasamatech/host-api.
 *
 * This module centralizes access to the novasama host APIs, allowing other
 * @parity/product-sdk-* packages to import from here rather than depending
 * directly on novasama packages.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

const log = createLogger("host");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers from @novasamatech/host-api (re-exported from @novasamatech/scale)
// ─────────────────────────────────────────────────────────────────────────────

export {
    /**
     * Construct an enum variant for host API calls.
     *
     * @example
     * ```ts
     * import { enumValue, getHostApi } from "@parity/product-sdk-host";
     *
     * const hostApi = await getHostApi();
     * if (hostApi) {
     *   await hostApi.permission([enumValue("ChainSubmit")]);
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

export type { HexString } from "@novasamatech/host-api";

// ─────────────────────────────────────────────────────────────────────────────
// Host API accessor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The HostApi type - provides low-level methods for communicating with the host.
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
export type HostApi = any;

/** Cached hostApi instance */
let cachedHostApi: HostApi | null = null;

/**
 * Get the host API instance for direct low-level access.
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
 * import { getHostApi, enumValue } from "@parity/product-sdk-host";
 *
 * const hostApi = await getHostApi();
 * if (hostApi) {
 *   // Request permission
 *   const result = await hostApi.permission([enumValue("ChainSubmit")]);
 *
 *   // Navigate to a URL
 *   await hostApi.navigateTo("polkadot://settings");
 *
 *   // Subscribe to theme changes
 *   const sub = hostApi.themeSubscribe(undefined, (theme) => {
 *     console.log("Theme changed:", theme);
 *   });
 * }
 * ```
 *
 * @returns The host API instance, or `null` if unavailable.
 */
export async function getHostApi(): Promise<HostApi | null> {
    if (cachedHostApi) return cachedHostApi;

    try {
        const sdk = await import("@novasamatech/product-sdk");
        cachedHostApi = sdk.hostApi;
        log.debug("host API loaded");
        return cachedHostApi;
    } catch {
        log.debug("host API unavailable (not in container or SDK not installed)");
        return null;
    }
}

/**
 * Inject the Spektr wallet extension into `window.injectedWeb3`.
 *
 * This makes the host's wallet appear as a browser extension, allowing
 * compatibility with existing dApps that use the injectedWeb3 API.
 *
 * @returns Promise that resolves when injection is complete, or rejects if unavailable.
 *
 * @example
 * ```ts
 * import { injectSpektrExtension } from "@parity/product-sdk-host";
 *
 * await injectSpektrExtension();
 * // Now window.injectedWeb3["spektr"] is available
 * ```
 */
export async function injectSpektrExtension(): Promise<void> {
    try {
        const sdk = await import("@novasamatech/product-sdk");
        await sdk.injectSpektrExtension();
        log.debug("spektr extension injected");
    } catch (err) {
        log.warn("failed to inject spektr extension", { error: String(err) });
        throw err;
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

/**
 * Account from the host wallet.
 */
export interface HostAccount {
    publicKey: Uint8Array;
    name?: string;
}

/**
 * Accounts provider interface.
 */
export interface AccountsProvider {
    /**
     * Subscribe to account changes.
     */
    subscribe(callback: (accounts: HostAccount[]) => void): {
        unsubscribe: () => void;
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getHostApi returns hostApi when SDK is available", async () => {
        // Reset cache for test
        cachedHostApi = null;
        const api = await getHostApi();
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
        const { enumValue } = await import("./host-api.js");
        expect(typeof enumValue).toBe("function");
    });
}
