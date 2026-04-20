import type { PolkadotSigner } from "polkadot-api";

import type { SS58String } from "@parity/product-sdk-address";

import type { SignerError } from "./errors.js";

/** Connection status for a signer provider. */
export type ConnectionStatus = "disconnected" | "connecting" | "connected";

/** Identifies the source of an account. */
export type ProviderType = "host" | "extension" | "dev";

/** A signing-capable account from any provider. */
export interface SignerAccount {
    /** SS58 address (generic prefix 42 by default). */
    address: SS58String;
    /**
     * H160 EVM address derived from the public key.
     *
     * For native Substrate accounts: keccak256(publicKey), last 20 bytes.
     * For EVM-derived accounts: strips the 0xEE padding.
     * Used for pallet-revive / Asset Hub EVM contract interactions.
     */
    h160Address: `0x${string}`;
    /** Raw public key (32 bytes). May be sr25519, ed25519, or ecdsa depending on the provider. */
    publicKey: Uint8Array;
    /** Human-readable name if available from the provider. */
    name: string | null;
    /** Which provider supplied this account. */
    source: ProviderType;
    /** Get the PolkadotSigner for this account. */
    getSigner(): PolkadotSigner;
}

/** Full state snapshot emitted to subscribers. */
export interface SignerState {
    /** Current connection status. */
    status: ConnectionStatus;
    /** All available accounts across all connected providers. */
    accounts: readonly SignerAccount[];
    /** Currently selected account (null if none selected). */
    selectedAccount: SignerAccount | null;
    /** Which provider is active (null if disconnected). */
    activeProvider: ProviderType | null;
    /** Last error (null if no error). */
    error: SignerError | null;
}

/** Lightweight Result type for operations that can fail expectedly. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Create a successful Result. */
export function ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
}

/** Create a failed Result. */
export function err<E>(error: E): Result<never, E> {
    return { ok: false, error };
}

/** Factory function that creates a SignerProvider for a given type. */
export type ProviderFactory = (type: ProviderType) => import("./providers/types.js").SignerProvider;

/**
 * Adapter for persisting the selected account address across sessions.
 *
 * `globalThis.localStorage` satisfies this interface. Pass a custom
 * implementation for container environments (e.g., hostLocalStorage)
 * or for testing.
 */
export interface AccountPersistence {
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
    removeItem(key: string): void | Promise<void>;
}

/** Options for SignerManager construction. */
export interface SignerManagerOptions {
    /** SS58 prefix for address encoding. Default: 42 */
    ss58Prefix?: number;
    /**
     * Maximum time in ms to wait for the Host API when inside a container.
     * Applied as an AbortSignal timeout on the host provider connection.
     * Only used during auto-detection inside containers.
     * Default: 10_000
     */
    hostTimeout?: number;
    /** Timeout in ms for extension injection delay. Default: 1_000 */
    extensionTimeout?: number;
    /** Maximum retry attempts for provider connection. Default: 3 */
    maxRetries?: number;
    /** Custom provider factory. Override to inject test doubles or custom providers. */
    createProvider?: ProviderFactory;
    /**
     * App name used for storage key namespacing. Default: "product-sdk"
     * The selected account is persisted under `product-sdk:signer:{dappName}:selectedAccount`.
     */
    dappName?: string;
    /**
     * Storage adapter for persisting selected account.
     * Defaults to `globalThis.localStorage` in browser, no-op in Node.
     * Set to `null` to disable persistence entirely.
     */
    persistence?: AccountPersistence | null;
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("ok", () => {
        test("produces ok result with value", () => {
            const result = ok(42);
            expect(result.ok).toBe(true);
            expect(result).toEqual({ ok: true, value: 42 });
        });

        test("works with complex values", () => {
            const result = ok({ name: "Alice", age: 30 });
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.name).toBe("Alice");
            }
        });

        test("works with null value", () => {
            const result = ok(null);
            expect(result).toEqual({ ok: true, value: null });
        });

        test("works with undefined value", () => {
            const result = ok(undefined);
            expect(result).toEqual({ ok: true, value: undefined });
        });
    });

    describe("err", () => {
        test("produces error result", () => {
            const result = err("something went wrong");
            expect(result.ok).toBe(false);
            expect(result).toEqual({ ok: false, error: "something went wrong" });
        });

        test("works with typed error objects", () => {
            const error = { type: "HOST_UNAVAILABLE" as const, message: "no host" };
            const result = err(error);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.type).toBe("HOST_UNAVAILABLE");
            }
        });
    });

    describe("Result type narrowing", () => {
        test("ok narrows to value access", () => {
            const result: Result<number, string> = ok(42);
            if (result.ok) {
                const value: number = result.value;
                expect(value).toBe(42);
            } else {
                expect.unreachable("should be ok");
            }
        });

        test("err narrows to error access", () => {
            const result: Result<number, string> = err("fail");
            if (!result.ok) {
                const error: string = result.error;
                expect(error).toBe("fail");
            } else {
                expect.unreachable("should be err");
            }
        });
    });
}
