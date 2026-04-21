/**
 * Host container detection and APIs.
 *
 * Re-exports from @parity/product-sdk-host.
 *
 * @example
 * ```ts
 * import { getTruApi, enumValue, isInsideContainer } from '@parity/product-sdk/host';
 *
 * if (await isInsideContainer()) {
 *   const truApi = await getTruApi();
 *   await truApi.navigateTo('polkadot://settings');
 * }
 * ```
 *
 * @packageDocumentation
 */

export {
    // Container detection
    isInsideContainer,
    isInsideContainerSync,
    // Host storage
    getHostLocalStorage,
    // Host provider
    getHostProvider,
    // Statement store
    getStatementStore,
    // TruAPI
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
    // Chain constants
    BULLETIN_RPCS,
    DEFAULT_BULLETIN_ENDPOINT,
} from "@parity/product-sdk-host";

export type {
    // Types
    HostLocalStorage,
    HostStatementStore,
    StatementProof,
    TruApi,
    HexString,
    PreimageManager,
    AccountsProvider,
    HostAccount,
} from "@parity/product-sdk-host";
