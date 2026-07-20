// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
    ChainNotSupportedError,
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

// TruAPI - @parity/truapi client accessor + convenience wrappers.
export {
    getTruApi,
    getPreimageManager,
    createHostPreimageManager,
    requestResourceAllocation,
    createProofAuthorized,
    // Hex helpers
    toHex,
    fromHex,
} from "./truapi.js";
export type {
    TruApi,
    HexString,
    PreimageManager,
    ResultAsync,
    AllocatableResource,
    AllocationOutcome,
    RemotePermission,
} from "./truapi.js";

// Result type + typed host errors (the throw→Result boundary)
export { ok, err } from "./result.js";
export type { Result } from "./result.js";
export { type SdkError, isSdkError } from "@parity/product-sdk-errors";
export {
    HostError,
    HostUnavailableError,
    HostCallFailedError,
    isHostError,
    formatHostError,
    toHostErrorPayload,
} from "./errors.js";
export type { HostErrorPayload, HostWireError } from "./errors.js";

// Accounts — host wallet accounts, product accounts, Ring VRF, and signers.
export { getAccountsProvider } from "./accounts.js";
export type {
    AccountsProvider,
    HostAccount,
    ProductAccount,
    ContextualAlias,
    ProductProofContext,
    RingLocation,
    RingLocationJunction,
} from "./accounts.js";

// Higher-level permission wrappers
export { requestPermission, requestDevicePermission } from "./permissions.js";
export type { DevicePermissionKind, RemotePermissionItem } from "./permissions.js";

// Theme provider
export { getThemeProvider } from "./theme.js";
export type { ThemeMode, ThemeName, ThemeProvider, ThemeVariant } from "./theme.js";

// Entropy derivation (RFC-0007)
export { deriveEntropy } from "./entropy.js";

// Chat
export { getChatManager } from "./chat.js";
export type {
    ChatManager,
    ChatMessageContent,
    ChatReceivedAction,
    ChatRoom,
    ChatRoomRegistrationResult,
    ChatBotRegistrationResult,
} from "./chat.js";

// Payments (RFC-0006)
export { getPaymentManager } from "./payments.js";
export type { PaymentManager } from "./payments.js";
export type {
    HostPaymentBalanceSubscribeItem,
    HostPaymentStatusSubscribeItem,
    PaymentTopUpSource,
} from "@parity/truapi";

// CoinPayment (RFC-0017)
export { getCoinPaymentManager } from "./coin-payment.js";
export type { CoinPaymentManager } from "./coin-payment.js";
export type {
    CoinPaymentBalance,
    CoinPaymentCheque,
    CoinPaymentError,
    CoinPaymentPurseId,
    CoinPaymentPurseInfo,
    CoinPaymentReceivable,
    CoinPaymentStatus,
    CoinPaymentTransmissionChannel,
    HostCoinPaymentListenForItem,
} from "@parity/truapi";

// Notifications
export { getNotificationManager } from "./notifications.js";
export type {
    NotificationManager,
    NotificationId,
    PushNotificationInput,
    PushNotificationError,
} from "./notifications.js";

// Deep-link navigation
export { navigateTo } from "./navigation.js";

// Feature / chain support probes
export { featureSupported, isChainSupported } from "./features.js";
export type { Feature } from "./features.js";

// Chain spec lookups
export { getChainSpec } from "./chain-spec.js";
export type { ChainSpec, ChainProperties } from "./chain-spec.js";

// Transaction broadcast lifecycle
export { broadcastTransaction, stopTransaction } from "./chain-transaction.js";

// Peer-to-peer media rooms (MoQ-over-iroh)
export {
    p2pStatus,
    createRoom,
    joinRoom,
    leaveRoom,
    mediaEndpoint,
    publish as p2pPublish,
    unpublish as p2pUnpublish,
    roomEvents,
} from "./p2p.js";
export type {
    P2pStatus,
    P2pRoom,
    P2pRoomOptions,
    P2pDirections,
    P2pEndpoint,
    P2pRoomEvent,
    P2pError,
    P2pFailure,
} from "./p2p.js";
