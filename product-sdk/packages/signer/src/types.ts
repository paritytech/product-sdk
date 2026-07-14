// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { PolkadotSigner } from "polkadot-api";

import type { SS58String } from "@parity/product-sdk-address";
import type { AllocatableResource, AllocationOutcome } from "@parity/product-sdk-host";

import type { SignerError } from "./errors.js";

/** Connection status for a signer provider. */
export type ConnectionStatus = "disconnected" | "connecting" | "connected";

/**
 * Identifies the source of an account.
 *
 * - `"host"`: Host API provider (Polkadot Desktop / Mobile) — the primary provider
 * - `"dev"`: Development accounts (Alice, Bob, etc.) — for testing only
 */
export type ProviderType = "host" | "dev";

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

/**
 * Result type for operations that can fail expectedly — re-exported from the
 * shared `@parity/result` leaf so the whole SDK shares one
 * definition. This module stays as the signer-internal import path.
 */
export { type Result, ok, err } from "@parity/result";

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
     * Maximum time in ms to wait for the Host API.
     * Applied as an AbortSignal timeout on the host provider connection.
     * Default: 10_000
     */
    hostTimeout?: number;
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
     * Uses host localStorage when inside a container.
     * Set to `null` to disable persistence entirely.
     */
    persistence?: AccountPersistence | null;
    /**
     * Callback fired exactly when the manager transitions to `connected`
     * with a selected account — not on subsequent state mutations while
     * still connected. Fires again after auto-reconnect, so a fresh host
     * session re-runs the callback.
     *
     * Common use: request product resource allocations once per session.
     * The `ctx` exposes a pre-bound `requestResourceAllocation` helper
     * plus an `AbortSignal` that fires if the user disconnects or
     * destroys the manager mid-flight.
     *
     * `requestResourceAllocation` throws on failure (it adapts the
     * `Result`-returning `@parity/product-sdk-host` export of the same name,
     * re-throwing the typed error on the `err` channel); errors thrown from
     * `onConnect` are logged but do not affect the connected state — the next
     * reconnect retries.
     *
     * @example
     * ```ts
     * new SignerManager({
     *   onConnect: async (_account, { requestResourceAllocation, signal }) => {
     *     try {
     *       const outcomes = await requestResourceAllocation([
     *         { tag: "AutoSigning", value: undefined },
     *       ]);
     *       if (signal.aborted) return;
     *       if (outcomes.some((o) => o !== "Allocated")) {
     *         logWarning("partial permissions", outcomes);
     *       }
     *     } catch (cause) {
     *       logWarning("resource allocation failed", cause);
     *     }
     *   },
     * });
     * ```
     */
    onConnect?: OnConnect;
}

/** Context passed to the `onConnect` callback. */
export interface ConnectContext {
    /**
     * Aborted when the manager disconnects or is destroyed while the
     * callback is still running. Pass through to `fetch` / cancellation
     * primitives so mid-flight work stops promptly.
     */
    signal: AbortSignal;
    /**
     * Request a batch of host resource allocations. Adapts
     * `requestResourceAllocation` from `@parity/product-sdk-host` (which returns
     * a `Result`) to this throwing contract — returns the unwrapped outcomes on
     * success, throws the typed host error on failure.
     */
    requestResourceAllocation: (resources: AllocatableResource[]) => Promise<AllocationOutcome[]>;
}

/** Callback signature for {@link SignerManagerOptions.onConnect}. */
export type OnConnect = (account: SignerAccount, ctx: ConnectContext) => void | Promise<void>;

// `Result` / `ok` / `err` are re-exported from `@parity/result`,
// which owns their unit tests; nothing to test here.
