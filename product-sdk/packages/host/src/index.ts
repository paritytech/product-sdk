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
    getHostProvider,
    getStatementStore,
} from "./container.js";
export type {
    HostLocalStorage,
    HostStatementStore,
    HostSubscription,
    StatementProof,
    StatementTopicFilter,
    StatementsPage,
} from "./types.js";
export { BULLETIN_RPCS, DEFAULT_BULLETIN_ENDPOINT } from "./chains.js";

// TruAPI - re-exports from @novasamatech/host-api-wrapper and @novasamatech/host-api
export {
    getTruApi,
    getPreimageManager,
    getAccountsProvider,
    requestResourceAllocation,
    createProofAuthorized,
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
    Statement,
} from "./truapi.js";

// Higher-level permission wrapper
export { requestPermission } from "./permissions.js";
