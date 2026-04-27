/**
 * @parity/product-sdk-signer — Account connection and signing, decoupled from where the keys actually live.
 *
 * `SignerManager` wraps one or more `SignerProvider` implementations behind a
 * `Result`-typed API for connecting, listing accounts, and reacting to status or
 * account changes. The two built-in providers — `HostProvider` (Polkadot
 * Desktop/Mobile) and `DevProvider` (the well-known Alice/Bob accounts) — let
 * the same call sites work in production and in tests.
 *
 * @packageDocumentation
 */

// Core manager
export { SignerManager } from "./signer-manager.js";

// Types
export type {
    AccountPersistence,
    ConnectionStatus,
    ProviderFactory,
    ProviderType,
    Result,
    SignerAccount,
    SignerManagerOptions,
    SignerState,
} from "./types.js";
export { err, ok } from "./types.js";

// Errors
export {
    SignerError,
    HostUnavailableError,
    HostRejectedError,
    HostDisconnectedError,
    SigningFailedError,
    NoAccountsError,
    TimeoutError,
    AccountNotFoundError,
    DestroyedError,
    isHostError,
} from "./errors.js";

// Utilities
export { sleep } from "./sleep.js";
export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";

// Provider interface and implementations
export type { SignerProvider, Unsubscribe } from "./providers/types.js";
export { DevProvider } from "./providers/dev.js";
export type { DevProviderOptions, DevAccountName, DevKeyType } from "./providers/dev.js";
export { HostProvider } from "./providers/host.js";
export type {
    HostProviderOptions,
    ProductAccount,
    ContextualAlias,
    RingLocation,
} from "./providers/host.js";
