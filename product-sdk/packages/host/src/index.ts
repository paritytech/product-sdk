/**
 * @parity/product-sdk-host — Detect and talk to the Polkadot Desktop/Mobile host container.
 *
 * Use `isInsideContainer` to branch behavior when running embedded vs. standalone,
 * and `getHostLocalStorage`, `getHostProvider`, and `getStatementStore` to reach
 * the storage, signer, and statement-store APIs the host injects.
 *
 * @packageDocumentation
 */
export {
    isInsideContainer,
    isInsideContainerSync,
    getHostLocalStorage,
    createHostLocalStorage,
    getHostProvider,
    getStatementStore,
} from "./container.js";
export type {
    HostLocalStorage,
    HostStatementStore,
    HostSubscription,
    ProductAccountId,
    SignedStatement,
    Statement,
    StatementProof,
    StatementTopicFilter,
    StatementsPage,
    Topic,
} from "./types.js";
export { BULLETIN_RPCS, DEFAULT_BULLETIN_ENDPOINT } from "./chains.js";

// TruAPI - re-exports from @novasamatech/host-api-wrapper and @novasamatech/host-api
export {
    getTruApi,
    getPreimageManager,
    createHostPreimageManager,
    getAccountsProvider,
    requestResourceAllocation,
    createProofAuthorized,
    formatHostError,
    // Helpers from @novasamatech/host-api
    enumValue,
    isEnumVariant,
    assertEnumVariant,
    unwrapResultOrThrow,
    resultOk,
    resultErr,
    toHex,
    fromHex,
} from "./truapi.js";
export type {
    TruApi,
    HexString,
    PreimageManager,
    AccountsProvider,
    HostAccount,
    ProductAccount,
    ContextualAlias,
    ResultAsync,
    AllocatableResource,
    AllocatableResourceTag,
    AllocationOutcome,
    AllocationOutcomeTag,
    RemotePermission,
    RemotePermissionTag,
} from "./truapi.js";

// Higher-level permission wrappers
export { requestPermission, requestDevicePermission } from "./permissions.js";
export type { DevicePermissionKind, RemotePermissionItem } from "./permissions.js";

// Theme provider
export { getThemeProvider } from "./theme.js";
export type { ThemeMode, ThemeProvider } from "./theme.js";

// Entropy derivation (RFC-0007)
export { deriveEntropy } from "./entropy.js";

// Chat
export { getChatManager, matchChatCustomRenderers } from "./chat.js";
export type {
    ChatManager,
    ChatMessageContent,
    ChatReceivedAction,
    ChatRoom,
    ChatRoomRegistrationResult,
    ChatBotRegistrationResult,
    ChatCustomMessageRenderer,
    ChatCustomMessageRendererParams,
} from "./chat.js";
