// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-react — React hooks for Polkadot apps on TanStack Query: chain queries, accounts, transactions, contracts, host features, chat, statements, payments and cloud storage.
 *
 * Wrap the app in `TruapiProvider` and use any `use*` hook. Everything an app needs from
 * `@parity/product-sdk-hooks-core` is re-exported here, so this is the only import site.
 *
 * @packageDocumentation
 */
export {
    TruapiProvider,
    createTruapiQueryClient,
    useRuntime,
    type ChainKey,
    type Register,
    type ResolvedChains,
    type TruapiProviderProps,
} from "./context.js";
export type {
    LiveListQueryResult,
    MutationOptions,
    NamedMutation,
    OptionalVariables,
    QueryOptions,
} from "./internal.js";

export * from "./hooks/host.js";
export * from "./hooks/chain.js";
export * from "./hooks/accounts.js";
export * from "./hooks/tx.js";
export * from "./hooks/contracts.js";
export * from "./hooks/chat.js";
export * from "./hooks/statements.js";
export * from "./hooks/payments.js";
export * from "./hooks/storage.js";
export * from "./hooks/preimage.js";
export * from "./hooks/pocket.js";
export * from "./hooks/format.js";

// Everything an app needs from core, re-exported so `@parity/product-sdk-react` is
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
