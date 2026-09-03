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
    CustomRendererNode,
    HostChatActionSubscribeItem,
    HostChatCreateRoomRequest,
    HostChatRegisterBotRequest,
    ObservableSource,
    ProductChatCustomMessageRenderRequest,
    TrUApiClient,
} from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { getNativeChatManager, isNativeChatHost } from "./nativeChat.js";
import { fromHex, unwrapHostResult } from "./truapi.js";
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

/** Request delivered when the host needs a native tree for a stored custom message. */
export type ChatCustomMessageRenderingRequest = Omit<
    ProductChatCustomMessageRenderRequest,
    "payload"
> & {
    payload: Uint8Array;
    subscribeActions(
        callback: (actionId: string, payload: Uint8Array | undefined) => void,
    ): VoidFunction;
};

/** Product callback that streams native renderer trees for one custom message. */
export type ChatCustomMessageRenderingRequestHandler = (
    request: ChatCustomMessageRenderingRequest,
) => ObservableSource<CustomRendererNode>;

/** Registration returned by the custom-message renderer channel. */
export interface ChatCustomMessageRenderingRegistration {
    unsubscribe(): void;
}

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
    onCustomMessageRenderingRequest(
        handler: ChatCustomMessageRenderingRequestHandler,
    ): ChatCustomMessageRenderingRegistration;
}

type RendererActionListener = (actionId: string, payload: Uint8Array | undefined) => void;

interface ActionListener {
    next(action: ChatReceivedAction): void;
    interrupt?: (reason?: unknown) => void;
}

/** Build a {@link ChatManager} over a TruAPI client's `chat` domain. */
function adaptChatManager(client: TrUApiClient): ChatManager {
    const chat = client.chat;
    // Cache registration status by id so repeat calls don't re-prompt the host.
    const roomStatus = new Map<string, ChatRoomRegistrationResult>();
    const botStatus = new Map<string, ChatBotRegistrationResult>();
    const actionListeners = new Set<ActionListener>();
    const rendererActionListeners = new Map<string, Set<RendererActionListener>>();
    let actionSubscription: HostSubscription | undefined;

    const stopActionsIfUnused = () => {
        if (actionListeners.size > 0 || rendererActionListeners.size > 0) return;
        actionSubscription?.unsubscribe();
        actionSubscription = undefined;
    };

    const ensureActionSubscription = () => {
        if (actionSubscription) return;

        actionSubscription = subscribeWithInterrupt(chat.actionSubscribe(), (action) => {
            for (const listener of actionListeners) listener.next(action);

            if (action.payload.tag !== "ActionTriggered") return;
            const { messageId: actionMessageId, actionId, payload } = action.payload.value;
            const decodedPayload = payload === undefined ? undefined : fromHex(payload);
            for (const listener of rendererActionListeners.get(actionMessageId) ?? []) {
                listener(actionId, decodedPayload);
            }
        });
        actionSubscription.onInterrupt((reason) => {
            actionSubscription = undefined;
            for (const listener of actionListeners) listener.interrupt?.(reason);
        });
    };

    const disposeRendererActions = () => {
        rendererActionListeners.clear();
        stopActionsIfUnused();
    };

    const subscribeRendererActions = (
        messageId: string,
        callback: RendererActionListener,
    ): VoidFunction => {
        const listeners =
            rendererActionListeners.get(messageId) ?? new Set<RendererActionListener>();
        listeners.add(callback);
        rendererActionListeners.set(messageId, listeners);
        ensureActionSubscription();

        return () => {
            listeners.delete(callback);
            if (listeners.size === 0) rendererActionListeners.delete(messageId);
            stopActionsIfUnused();
        };
    };

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
            const listener: ActionListener = { next: callback };
            let active = true;
            actionListeners.add(listener);
            ensureActionSubscription();

            return {
                unsubscribe() {
                    if (!active) return;
                    active = false;
                    actionListeners.delete(listener);
                    stopActionsIfUnused();
                },
                onInterrupt(interrupt) {
                    listener.interrupt = interrupt;
                    return () => {
                        if (listener.interrupt === interrupt) listener.interrupt = undefined;
                    };
                },
            };
        },
        onCustomMessageRenderingRequest(handler) {
            const registration = chat.onCustomMessageRender((request) =>
                handler({
                    messageId: request.messageId,
                    messageType: request.messageType,
                    payload: fromHex(request.payload),
                    subscribeActions: (callback) =>
                        subscribeRendererActions(request.messageId, callback),
                }),
            );

            return {
                unsubscribe() {
                    registration.unsubscribe();
                    disposeRendererActions();
                },
            };
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
    if (client) return adaptChatManager(client);
    // No truapi host: fall back to the legacy native chat backend when present,
    // so chat products keep working on the native backend during the transition.
    // The novasama wrapper is loaded on demand so truapi-only products never
    // bundle it.
    if (isNativeChatHost()) return getNativeChatManager();
    return null;
}

if (import.meta.vitest) {
    const { test, expect, vi } = import.meta.vitest;

    test("getChatManager returns null outside a container", async () => {
        expect(await getChatManager()).toBeNull();
    });

    test("custom renderer requests decode payloads and receive message-scoped actions", () => {
        let renderHandler:
            | ((
                  request: ProductChatCustomMessageRenderRequest,
              ) => ObservableSource<CustomRendererNode>)
            | undefined;
        let actionObserver: ((action: HostChatActionSubscribeItem) => void) | undefined;
        const stopRender = vi.fn();
        const stopActions = vi.fn();
        const actionSubscribe = vi.fn(() => ({
            subscribe(observer: { next?(action: HostChatActionSubscribeItem): void }) {
                actionObserver = observer.next;
                return {
                    subscriptionId: "action-subscription",
                    unsubscribe: stopActions,
                };
            },
            [Symbol.observable]() {
                return this;
            },
        }));
        const client = {
            chat: {
                onCustomMessageRender(handler: typeof renderHandler) {
                    renderHandler = handler;
                    return { unsubscribe: stopRender };
                },
                actionSubscribe,
            },
        } as unknown as TrUApiClient;
        const manager = adaptChatManager(client);
        const receivedMessages: HostChatActionSubscribeItem[] = [];
        const receivedActions: Array<[string, Uint8Array | undefined]> = [];
        const messageSubscription = manager.subscribeAction((action) => {
            receivedMessages.push(action);
        });

        const registration = manager.onCustomMessageRenderingRequest((request) => {
            expect(request.payload).toEqual(Uint8Array.of(1, 2));
            request.subscribeActions((actionId, payload) => {
                receivedActions.push([actionId, payload]);
            });
            return {
                subscribe: () => ({ unsubscribe: () => undefined }),
            };
        });
        renderHandler?.({
            messageId: "message-1",
            messageType: "result",
            payload: "0x0102",
        });
        const postedAction: HostChatActionSubscribeItem = {
            roomId: "room-1",
            peer: "peer-1",
            payload: {
                tag: "MessagePosted",
                value: { tag: "Text", value: { text: "!flip" } },
            },
        };
        actionObserver?.(postedAction);
        actionObserver?.({
            roomId: "room-1",
            peer: "peer-1",
            payload: {
                tag: "ActionTriggered",
                value: {
                    messageId: "message-1",
                    actionId: "flip-again",
                    payload: "0x03",
                },
            },
        });

        expect(actionSubscribe).toHaveBeenCalledOnce();
        expect(receivedMessages).toHaveLength(2);
        expect(receivedMessages[0]).toEqual(postedAction);
        expect(receivedActions).toEqual([["flip-again", Uint8Array.of(3)]]);
        registration.unsubscribe();
        expect(stopRender).toHaveBeenCalledOnce();
        expect(stopActions).not.toHaveBeenCalled();
        messageSubscription.unsubscribe();
        expect(stopActions).toHaveBeenCalledOnce();
    });
}
