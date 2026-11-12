// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-vue — Vue 3 composables for Polkadot apps on TanStack Query: chain queries, accounts, transactions, contracts, host features, chat, statements, payments and cloud storage.
 *
 * Install `TruapiPlugin` (`app.use(TruapiPlugin, { config })`) and use any `use*` composable.
 * Everything an app needs from `@parity/product-sdk-hooks-core` is re-exported here.
 *
 * @packageDocumentation
 */
export {
    RUNTIME_KEY,
    TruapiPlugin,
    createTruapiQueryClient,
    useRuntime,
    type ChainKey,
    type Register,
    type ResolvedChains,
    type TruapiPluginOptions,
} from "./context.js";
export type {
    LiveListQueryResult,
    MaybeGetter,
    MutationOptions,
    MutationResult,
    QueryOptions,
    QueryResult,
} from "./internal.js";

export * from "./composables/host.js";
export * from "./composables/chain.js";
export * from "./composables/accounts.js";
export * from "./composables/tx.js";
export * from "./composables/contracts.js";
export * from "./composables/chat.js";
export * from "./composables/statements.js";
export * from "./composables/payments.js";
export * from "./composables/storage.js";
export * from "./composables/preimage.js";
export * from "./composables/pocket.js";
export * from "./composables/format.js";

// Everything an app needs from core, re-exported so `@parity/product-sdk-vue` is
// the only import site.
export {
    defineConfig,
    createRuntime,
    queryKeys,
    toKeyPart,
    formatBalance,
    formatPlanck,
    parseToPlanck,
    truncateAddress,
    ss58Encode,
    ss58ToH160,
    h160ToSs58,
    toGenericSs58,
    addressesEqual,
    findRingVrfKeyHandle,
    isSdkError,
    HostError,
    HostUnavailableError,
    HostCallFailedError,
    ChainNotSupportedError,
    TxError,
    TxDispatchError,
    TxSigningRejectedError,
    TxValidityError,
    ContractError,
    ContractRevertedError,
    StatementStoreError,
} from "@parity/product-sdk-hooks-core";
export type {
    AbiEntry,
    AnyChains,
    CdmJson,
    ChainDefinition,
    ChainConfig,
    ContactHandle,
    ContactPickOutcome,
    Contract,
    ContractDef,
    HostChainDiscovery,
    HostChainIdentifier,
    HostConnectionStatus,
    HostInfo,
    HostPlatform,
    LocaleState,
    PocketCard,
    PocketCardAction,
    PolkadotClient,
    ProductContext,
    RegisteredRingVrfKey,
    RendererNode,
    RingLocation,
    RingVrfKeyHandle,
    Signer,
    SignerAccount,
    SignerState,
    ThemeState,
    TruapiConfig,
    TruapiRuntime,
    TxResult,
    TxStatus,
    VrfSignature,
    VrfTranscriptItem,
} from "@parity/product-sdk-hooks-core";
