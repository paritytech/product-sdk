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
    ExtensionNotFoundError,
    ExtensionRejectedError,
    SigningFailedError,
    NoAccountsError,
    TimeoutError,
    AccountNotFoundError,
    DestroyedError,
    isHostError,
    isExtensionError,
} from "./errors.js";

// Utilities
export { sleep } from "./sleep.js";
export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";

// Provider interface and implementations
export type { SignerProvider, Unsubscribe } from "./providers/types.js";
export { DevProvider } from "./providers/dev.js";
export type { DevProviderOptions, DevAccountName, DevKeyType } from "./providers/dev.js";
export { ExtensionProvider } from "./providers/extension.js";
export type { ExtensionProviderOptions, ExtensionApi } from "./providers/extension.js";
export { HostProvider } from "./providers/host.js";
export type {
    HostProviderOptions,
    ProductAccount,
    ContextualAlias,
    RingLocation,
} from "./providers/host.js";
