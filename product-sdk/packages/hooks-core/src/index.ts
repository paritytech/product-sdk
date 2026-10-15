// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-hooks-core — Framework-agnostic runtime shared by `@parity/product-sdk-react` and `@parity/product-sdk-vue`: host detection, chain clients, signers, transactions, contracts, chat, statements, payments and cloud storage for Polkadot apps.
 *
 * Apps normally install a framework binding rather than this package. `createRuntime(config)`
 * wires one controller per area into a `TruapiRuntime`; the bindings subscribe to its stores
 * and feed its `watch*` subscriptions into TanStack Query.
 *
 * @packageDocumentation
 */
export * from "./async-state.js";
export * from "./store.js";
export * from "./config.js";
export * from "./query-keys.js";
export * from "./live-query.js";
export * from "./runtime.js";
export { createHostController, isUnsupportedCall, unwrapResult } from "./host.js";
export type {
    ContactHandle,
    ContactPickOutcome,
    HostChainDiscovery,
    HostChainIdentifier,
    HostConnectionStatus,
    HostController,
    HostInfo,
    HostKvStorage,
    HostMode,
    HostPlatform,
    HostWorker,
    ProductContext,
} from "./host.js";
export type {
    CardDrawHandler,
    CardRender,
    PocketCard,
    PocketCardAction,
    PocketController,
    RenderContextTag,
    RenderHandler,
    RendererController,
    RendererNode,
} from "./pocket.js";
export type { ThemeState } from "./theme.js";
export type { LocaleState } from "./locale.js";
export type { HexString, PreimageController } from "./preimage.js";
export type {
    AccountBalance,
    ChainController,
    PolkadotClient,
    ObservableLike,
    TypedApiOf,
    Unsubscribable,
} from "./chain.js";
export { findRingVrfKeyHandle } from "./accounts.js";
export type {
    AccountsController,
    ContextualAlias,
    LoginResult,
    ProductAccountLookup,
    ProductProofContext,
    ProviderType,
    RegisteredRingVrfKey,
    RingLocation,
    RingVRFProof,
    RingVrfKeyDisclosure,
    RingVrfKeyHandle,
    RingVrfPublicKey,
    Signer,
    SignerAccount,
    SignerError,
    SignerState,
    VrfSignature,
    VrfTranscriptItem,
} from "./accounts.js";
export type {
    AnyBatchCall,
    AnyTx,
    BatchMode,
    SubmitOptions,
    TxController,
    TxPhase,
    TxResult,
    TxStatus,
} from "./tx.js";
export type {
    AbiEntry,
    CdmJson,
    Contract,
    ContractDef,
    ContractsController,
} from "./contracts.js";
export type {
    ChatController,
    ChatManager,
    ChatMessageContent,
    ChatReceivedAction,
    ChatRoom,
    ChatRoomDefinition,
} from "./chat.js";
export type {
    PublishOptions,
    ReceivedStatement,
    StatementsController,
} from "./statements.js";
export type {
    PaymentBalance,
    PaymentPurseId,
    PaymentStatus,
    PaymentsController,
    PaymentTopUpSource,
} from "./payments.js";
export type {
    AuthorizationStatus,
    CloudStorageController,
    StoreResult,
    UploadOptions,
} from "./cloud-storage.js";
export * from "./utils.js";

// Re-exported so app code can catch/branch on SDK error types without
// installing the underlying packages.
export {
    ChainNotSupportedError,
    HostCallFailedError,
    HostError,
    HostResponseDecodeError,
    HostUnavailableError,
    isHostError,
    isSdkError,
} from "@parity/product-sdk-host";
export type { SdkError } from "@parity/product-sdk-host";
export {
    TxDispatchError,
    TxError,
    TxSigningRejectedError,
    TxTimeoutError,
    TxValidityError,
} from "@parity/product-sdk-tx";
export {
    ContractError,
    ContractNotFoundError,
    ContractRevertedError,
} from "@parity/product-sdk-contracts";
export {
    StatementConnectionError,
    StatementDataTooLargeError,
    StatementStoreError,
    StatementSubmitError,
} from "@parity/product-sdk-statement-store";
