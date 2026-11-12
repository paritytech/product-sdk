// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type ChatManager,
    type ChatReceivedAction,
    type ChatRoom,
    HostUnavailableError,
    getChatManager,
} from "@parity/product-sdk-host";
import type { HostController } from "./host.js";

export type { ChatManager, ChatReceivedAction, ChatRoom };

export type ChatMessageContent = Parameters<ChatManager["sendMessage"]>[1];

export interface ChatRoomDefinition {
    roomId: string;
    name: string;
    /** URL or base64 data URI. */
    icon: string;
}

export interface ChatController {
    /** Chat is a host capability; resolves null standalone. */
    getManager(): Promise<ChatManager | null>;
    /** Idempotent per roomId for the runtime's lifetime. */
    registerRoom(room: ChatRoomDefinition): Promise<"New" | "Exists">;
    registerBot(bot: { botId: string; name: string; icon: string }): Promise<"New" | "Exists">;
    /** A plain string is sugar for a Text message. */
    send(roomId: string, content: ChatMessageContent | string): Promise<{ messageId: string }>;
    watchActions(
        onAction: (action: ChatReceivedAction) => void,
        onError?: (error: unknown) => void,
    ): () => void;
    watchRooms(
        onRooms: (rooms: ChatRoom[]) => void,
        onError?: (error: unknown) => void,
    ): () => void;
}

export function createChatController(host: HostController): ChatController {
    let managerPromise: Promise<ChatManager | null> | null = null;
    const registeredRooms = new Map<string, Promise<"New" | "Exists">>();

    const getManager = (): Promise<ChatManager | null> => {
        if (!managerPromise) {
            managerPromise = host.detect().then((inside) => (inside ? getChatManager() : null));
            managerPromise.catch(() => {
                managerPromise = null;
            });
        }
        return managerPromise;
    };

    const requireManager = async (): Promise<ChatManager> => {
        const manager = await getManager();
        if (!manager) throw new HostUnavailableError("chat");
        return manager;
    };

    const subscribeVia =
        <T>(
            attach: (
                manager: ChatManager,
                cb: (value: T) => void,
            ) => ReturnType<ChatManager["subscribeAction"]>,
        ) =>
        (onValue: (value: T) => void, onError?: (error: unknown) => void): (() => void) => {
            let cancelled = false;
            let teardown: (() => void) | undefined;
            void requireManager()
                .then((manager) => {
                    if (cancelled) return;
                    const sub = attach(manager, onValue);
                    const offInterrupt = sub.onInterrupt((reason) => onError?.(reason));
                    teardown = () => {
                        offInterrupt();
                        sub.unsubscribe();
                    };
                })
                .catch((e) => {
                    if (!cancelled) onError?.(e);
                });
            return () => {
                cancelled = true;
                teardown?.();
            };
        };

    return {
        getManager,
        registerRoom: (room) => {
            let registration = registeredRooms.get(room.roomId);
            if (!registration) {
                registration = requireManager().then((manager) => manager.registerRoom(room));
                registration.catch(() => registeredRooms.delete(room.roomId));
                registeredRooms.set(room.roomId, registration);
            }
            return registration;
        },
        registerBot: async (bot) => (await requireManager()).registerBot(bot),
        send: async (roomId, content) =>
            (await requireManager()).sendMessage(
                roomId,
                typeof content === "string" ? { tag: "Text", value: { text: content } } : content,
            ),
        watchActions: subscribeVia((manager, cb) => manager.subscribeAction(cb)),
        watchRooms: subscribeVia((manager, cb) => manager.subscribeChatList(cb)),
    };
}
