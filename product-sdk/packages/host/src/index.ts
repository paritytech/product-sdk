export {
    isInsideContainer,
    isInsideContainerSync,
    getHostLocalStorage,
    getHostProvider,
    getStatementStore,
} from "./container.js";
export type { HostLocalStorage, HostStatementStore, StatementProof } from "./types.js";
export { BULLETIN_RPCS, DEFAULT_BULLETIN_ENDPOINT } from "./chains.js";

// TruAPI - re-exports from @novasamatech/product-sdk and @novasamatech/host-api
export {
    getTruApi,
    getPreimageManager,
    getAccountsProvider,
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
} from "./truapi.js";
