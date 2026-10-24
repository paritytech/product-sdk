// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-chat — build a chat product whose rooms the host draws.
 *
 * Through Chat Extension v2 a product's worker owns the data of its rooms and the
 * host draws them with native elements. This package holds what every such
 * product needs on top of the host bindings:
 *
 * - declaring rooms ({@link RoomDeclarations}), pushing their changes in order and
 *   within the host's rate ({@link FeedSender}), and keeping their place in the chat
 *   list ({@link PreviewScheduler}, {@link buildPreview});
 * - building messages, bodies, reactions and edit histories;
 * - answering the host's pages, searches and user actions ({@link serveRooms},
 *   {@link page}, {@link searchPage}, {@link userActions});
 * - streaming a long answer ({@link streamMessage}) and running the worker
 *   ({@link defineChatWorker});
 * - keeping a room's messages on the device and serving the room from them
 *   ({@link StoredRoom} over a {@link RoomMessageStore} on the journaled storage of
 *   `@parity/product-sdk-local-storage`, and {@link sessionScope} for per-identity data);
 * - the bounds, rates and waits of the RFCs ({@link ROOM_LIMITS}).
 *
 * The host bindings themselves (`getChatRooms`, `serveChatQueries`, the error
 * classes and the Chat Extension v2 types) are re-exported from
 * `@parity/product-sdk-host`, so a chat product imports from here alone. Test
 * helpers are in `@parity/product-sdk-chat/testing`.
 *
 * @packageDocumentation
 */
export * from "./limits.js";
export * from "./ids.js";
export * from "./declarations.js";
export * from "./feed.js";
export * from "./previews.js";
export * from "./builders.js";
export * from "./paging.js";
export * from "./router.js";
export * from "./actions.js";
export * from "./stream.js";
export * from "./worker.js";
export * from "./message-store.js";
export * from "./stored-room.js";
export * from "./calls.js";
export * from "./links.js";
export * from "./media.js";

export {
    CallMediaNotAllowedError,
    ChatRoomError,
    FeatureUnavailableError,
    NotAvailableError,
    UnknownMessageError,
    UnknownRoomError,
    UserActionRejectedError,
    chatHostFeatures,
    createCallMedia,
    createChatRooms,
    getCallMedia,
    getChatManager,
    getChatRooms,
    roomDeeplink,
    serveChatQueries,
    serveChatQueriesOn,
} from "@parity/product-sdk-host";
export type {
    CallMedia,
    ChatCallClose,
    ChatCallRecord,
    ChatContactEvent,
    ChatContactState,
    ChatFeedUpdate,
    ChatHostFeatures,
    ChatManager,
    ChatMediaItem,
    ChatMediaMeta,
    ChatMessageBody,
    ChatMessageOrigin,
    ChatMessageRevision,
    ChatMessageStatus,
    ChatPageAnchor,
    ChatPaymentRecord,
    ChatPreviewReaction,
    ChatQueryHandlers,
    ChatQueryRegistration,
    ChatReactionDetail,
    ChatReactionSummary,
    ChatReplyPreview,
    ChatResource,
    ChatRoomBadge,
    ChatRoomCall,
    ChatRoomCalls,
    ChatRoomConfig,
    ChatRoomContact,
    ChatRoomEvent,
    ChatRoomFailure,
    ChatRoomFeatures,
    ChatRoomFooter,
    ChatRoomMessage,
    ChatRoomMetadata,
    ChatRoomPreview,
    ChatRoomRegistrationStatus,
    ChatRooms,
    ChatUserAction,
    HostChatCreateRoomRequest,
    HostChatRoomEventsSubscribeItem,
    ProductChatEditHistoryQueryItem,
    ProductChatEditHistoryQueryRequest,
    ProductChatMessagesQueryItem,
    ProductChatMessagesQueryRequest,
    ProductChatOpenLinkItem,
    ProductChatOpenLinkRequest,
    ProductChatReactionsQueryItem,
    ProductChatReactionsQueryRequest,
    ProductChatSearchQueryItem,
    ProductChatSearchQueryRequest,
    ProductChatUserActionItem,
    ProductChatUserActionRequest,
} from "@parity/product-sdk-host";
