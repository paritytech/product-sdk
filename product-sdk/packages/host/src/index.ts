export {
    isInsideContainer,
    isInsideContainerSync,
    getHostLocalStorage,
    getHostProvider,
    getStatementStore,
} from "./container.js";
export type { HostLocalStorage, HostStatementStore, StatementProof } from "./types.js";
export { BULLETIN_RPCS, DEFAULT_BULLETIN_ENDPOINT } from "./chains.js";

// Re-exports from @novasamatech/product-sdk and @novasamatech/host-api
export {
    getHostApi,
    injectSpektrExtension,
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
} from "./host-api.js";
export type {
    HostApi,
    HexString,
    PreimageManager,
    AccountsProvider,
    HostAccount,
} from "./host-api.js";
