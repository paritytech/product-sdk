// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { UseQueryResult } from "@tanstack/react-query";
import {
    type ChatMessageContent,
    type ChatReceivedAction,
    type ChatRoom,
    type ChatRoomDefinition,
    queryKeys,
} from "@parity/product-sdk-hooks-core";
import { useCallback, useEffect, useRef } from "react";
import { useRuntime } from "../context.js";
import {
    type LiveListQueryResult,
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    dropMutate,
    useLiveListQuery,
    useLiveQuery,
    useTruapiMutation,
    useTruapiQuery,
} from "../internal.js";

/** Register a chat room (idempotent). Chat is host-only. */
export function useChatRoom(
    room: ChatRoomDefinition,
    options?: { query?: QueryOptions<"New" | "Exists"> },
): UseQueryResult<"New" | "Exists", Error> {
    const runtime = useRuntime();
    return useTruapiQuery(
        queryKeys.chatRoom(room.roomId),
        () => runtime.chat.registerRoom(room),
        options,
    );
}

/** Register a bot identity for posting into rooms. */
export function useChatBot(
    bot: { botId: string; name: string; icon: string },
    options?: { query?: QueryOptions<"New" | "Exists"> },
): UseQueryResult<"New" | "Exists", Error> {
    const runtime = useRuntime();
    return useTruapiQuery(
        queryKeys.chatBot(bot.botId),
        () => runtime.chat.registerBot(bot),
        options,
    );
}

/** Rooms the product participates in, live. */
export function useChatRooms(options?: {
    query?: QueryOptions<ChatRoom[]>;
}): UseQueryResult<ChatRoom[], Error> {
    const runtime = useRuntime();
    return useLiveQuery<ChatRoom[]>({
        queryKey: queryKeys.chatRooms(),
        attach: (onValue, onError) => runtime.chat.watchRooms(onValue, onError),
        seed: () => [],
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

export interface ChatMessage {
    roomId: string;
    peer: string;
    content: ChatMessageContent;
    receivedAt: number;
}

/** Accumulated `MessagePosted` events for a room (bounded, newest last). */
export function useChatMessages(
    roomId: string | undefined,
    options?: { limit?: number; query?: QueryOptions<ChatMessage[]> },
): LiveListQueryResult<ChatMessage> {
    const runtime = useRuntime();
    return useLiveListQuery<ChatMessage>({
        queryKey: queryKeys.chatMessages(roomId ?? null),
        attach: (onValue, onError) =>
            runtime.chat.watchActions((action) => {
                if (action.payload.tag !== "MessagePosted") return;
                if (roomId !== undefined && action.roomId !== roomId) return;
                onValue({
                    roomId: action.roomId,
                    peer: action.peer,
                    content: action.payload.value,
                    receivedAt: Date.now(),
                });
            }, onError),
        limit: options?.limit ?? 200,
        enabled: roomId !== undefined,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

/** Raw action stream (messages, button triggers, commands) via a stable handler. */
export function useChatActions(
    onAction: (action: ChatReceivedAction) => void,
    options?: { enabled?: boolean; onError?: (error: unknown) => void },
): void {
    const runtime = useRuntime();
    const handlerRef = useRef(onAction);
    handlerRef.current = onAction;
    const onErrorRef = useRef(options?.onError);
    onErrorRef.current = options?.onError;
    const enabled = options?.enabled ?? true;

    useEffect(() => {
        if (!enabled) return;
        return runtime.chat.watchActions(
            (action) => handlerRef.current(action),
            (e) => onErrorRef.current?.(e),
        );
    }, [runtime, enabled]);
}

export interface SendChatMessageVariables {
    /** Plain strings become Text messages. */
    content: ChatMessageContent | string;
    /** Overrides the roomId given to the hook. */
    roomId?: string;
}

/** Send into a room: `send("hi")` or `send(content, roomId)`. */
export function useSendChatMessage(
    roomId?: string,
    options?: { mutation?: MutationOptions<{ messageId: string }, SendChatMessageVariables> },
): NamedMutation<{ messageId: string }, SendChatMessageVariables> & {
    send: (content: ChatMessageContent | string, roomId?: string) => Promise<{ messageId: string }>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ content, roomId: roomIdOverride }: SendChatMessageVariables) => {
            const target = roomIdOverride ?? roomId;
            if (!target) throw new Error("product-sdk: no roomId given to useSendChatMessage");
            return runtime.chat.send(target, content);
        },
        options?.mutation,
    );
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        send: useCallback(
            (content: ChatMessageContent | string, roomIdOverride?: string) =>
                mutateAsync({
                    content,
                    ...(roomIdOverride !== undefined ? { roomId: roomIdOverride } : {}),
                }),
            [mutateAsync],
        ),
    };
}
