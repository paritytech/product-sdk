// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's chat surface, backed by `truApi.chat.*`.
 *
 * `getChatManager()` returns a manager for room/bot registration, message
 * sending, and subscription to the room list and incoming actions.
 *
 * @module
 */

import type {
    ChatBotRegistrationStatus,
    ChatRoomRegistrationStatus,
    HostChatActionSubscribeItem,
    HostChatCreateRoomRequest,
    HostChatRegisterBotRequest,
    TrUApiClient,
} from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/** Chat message payload variants and room metadata. Re-exported from `@parity/truapi`. */
export type { ChatMessageContent, ChatRoom } from "@parity/truapi";
import type { ChatMessageContent, ChatRoom } from "@parity/truapi";

/** Action received via {@link ChatManager.subscribeAction} (`{ roomId, peer, payload }`). Re-exported from `@parity/truapi`. */
export type ChatReceivedAction = HostChatActionSubscribeItem;

/** Result of registering a chat room (`"New" | "Exists"`). Re-exported from `@parity/truapi`. */
export type ChatRoomRegistrationResult = ChatRoomRegistrationStatus;

/** Result of registering a bot (`"New" | "Exists"`). Re-exported from `@parity/truapi`. */
export type ChatBotRegistrationResult = ChatBotRegistrationStatus;

/**
 * Chat manager handle. Exposes room/bot registration, message sending, and
 * subscription to the room list and incoming actions.
 */
export interface ChatManager {
    registerRoom(request: HostChatCreateRoomRequest): Promise<ChatRoomRegistrationResult>;
    registerBot(request: HostChatRegisterBotRequest): Promise<ChatBotRegistrationResult>;
    sendMessage(roomId: string, payload: ChatMessageContent): Promise<{ messageId: string }>;
    subscribeChatList(callback: (rooms: ChatRoom[]) => void): HostSubscription;
    subscribeAction(callback: (action: ChatReceivedAction) => void): HostSubscription;
}

/** Build a {@link ChatManager} over a TruAPI client's `chat` domain. */
function adaptChatManager(client: TrUApiClient): ChatManager {
    const chat = client.chat;
    // Cache registration status by id so repeat calls don't re-prompt the host.
    const roomStatus = new Map<string, ChatRoomRegistrationResult>();
    const botStatus = new Map<string, ChatBotRegistrationResult>();

    return {
        async registerRoom(request) {
            const cached = roomStatus.get(request.roomId);
            if (cached) return cached;
            const response = await unwrapHostResult(
                chat.createRoom(request),
                "chat registerRoom failed",
            );
            roomStatus.set(request.roomId, response.status);
            return response.status;
        },
        async registerBot(request) {
            const cached = botStatus.get(request.botId);
            if (cached) return cached;
            const response = await unwrapHostResult(
                chat.registerBot(request),
                "chat registerBot failed",
            );
            botStatus.set(request.botId, response.status);
            return response.status;
        },
        async sendMessage(roomId, payload) {
            const response = await unwrapHostResult(
                chat.postMessage({ roomId, payload }),
                "chat sendMessage failed",
            );
            return { messageId: response.messageId };
        },
        subscribeChatList(callback) {
            return subscribeWithInterrupt(chat.listSubscribe(), (item) => callback(item.rooms));
        },
        subscribeAction(callback) {
            return subscribeWithInterrupt(chat.actionSubscribe(), callback);
        },
    };
}

/**
 * Get the host chat manager, backed by `truApi.chat.*`. Returns `null` when
 * running outside a host container.
 *
 * @returns The chat manager, or `null` if unavailable.
 *
 * @example
 * ```ts
 * import { getChatManager } from "@parity/product-sdk-host";
 *
 * const chat = await getChatManager();
 * if (chat) {
 *   await chat.registerBot({ botId: "echo", name: "Echo Bot", icon: "" });
 *   chat.subscribeAction((action) => { ... });
 * }
 * ```
 */
export async function getChatManager(): Promise<ChatManager | null> {
    const client = await getClient();
    return client ? adaptChatManager(client) : null;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getChatManager returns null outside a container", async () => {
        expect(await getChatManager()).toBeNull();
    });
}
