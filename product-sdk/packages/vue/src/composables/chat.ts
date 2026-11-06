// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type ChatMessageContent,
    type ChatReceivedAction,
    type ChatRoom,
    type ChatRoomDefinition,
    queryKeys,
} from "@parity/product-sdk-hooks-core";
import { watch as vueWatch } from "vue";
import { useRuntime } from "../context.js";
import {
    type LiveListQueryResult,
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    type QueryResult,
    dropMutate,
    toGetter,
    useLiveListQuery,
    useLiveQuery,
    useTruapiMutation,
    useTruapiQuery,
} from "../internal.js";

/** Register a chat room (idempotent). Chat is host-only. */
export function useChatRoom(
    room: ChatRoomDefinition,
    options?: { query?: QueryOptions<"New" | "Exists"> },
): QueryResult<"New" | "Exists"> {
    const runtime = useRuntime();
    return useTruapiQuery(
        () => queryKeys.chatRoom(room.roomId),
        () => runtime.chat.registerRoom(room),
        options,
    );
}

/** Register a bot identity for posting into rooms. */
export function useChatBot(
    bot: { botId: string; name: string; icon: string },
    options?: { query?: QueryOptions<"New" | "Exists"> },
): QueryResult<"New" | "Exists"> {
    const runtime = useRuntime();
    return useTruapiQuery(
        () => queryKeys.chatBot(bot.botId),
        () => runtime.chat.registerBot(bot),
        options,
    );
}

/** Rooms the product participates in, live. */
export function useChatRooms(options?: {
    query?: QueryOptions<ChatRoom[]>;
}): QueryResult<ChatRoom[]> {
    const runtime = useRuntime();
    return useLiveQuery<ChatRoom[]>({
        queryKey: () => queryKeys.chatRooms(),
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
    roomId: MaybeGetter<string | undefined>,
    options?: { limit?: number; query?: QueryOptions<ChatMessage[]> },
): LiveListQueryResult<ChatMessage> {
    const runtime = useRuntime();
    const getRoomId = toGetter(roomId);
    return useLiveListQuery<ChatMessage>({
        queryKey: () => queryKeys.chatMessages(getRoomId() ?? null),
        attach: (onValue, onError) =>
            runtime.chat.watchActions((action) => {
                const target = getRoomId();
                if (action.payload.tag !== "MessagePosted") return;
                if (target !== undefined && action.roomId !== target) return;
                onValue({
                    roomId: action.roomId,
                    peer: action.peer,
                    content: action.payload.value,
                    receivedAt: Date.now(),
                });
            }, onError),
        limit: options?.limit ?? 200,
        enabled: () => getRoomId() !== undefined,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

/** Raw action stream (messages, button triggers, commands). */
export function useChatActions(
    onAction: (action: ChatReceivedAction) => void,
    options?: { enabled?: MaybeGetter<boolean>; onError?: (error: unknown) => void },
): void {
    const runtime = useRuntime();
    const enabled = toGetter(options?.enabled ?? true);

    vueWatch(
        [enabled],
        (_next, _prev, onCleanup) => {
            if (!enabled()) return;
            onCleanup(runtime.chat.watchActions(onAction, options?.onError));
        },
        { immediate: true },
    );
}

export interface SendChatMessageVariables {
    /** Plain strings become Text messages. */
    content: ChatMessageContent | string;
    /** Overrides the roomId given to the composable. */
    roomId?: string;
}

/** Send into a room: `send("hi")` or `send(content, roomId)`. */
export function useSendChatMessage(
    roomId?: MaybeGetter<string | undefined>,
    options?: { mutation?: MutationOptions<{ messageId: string }, SendChatMessageVariables> },
): NamedMutation<{ messageId: string }, SendChatMessageVariables> & {
    send: (content: ChatMessageContent | string, roomId?: string) => Promise<{ messageId: string }>;
} {
    const runtime = useRuntime();
    const getRoomId = toGetter(roomId ?? (() => undefined));
    const mutation = useTruapiMutation(
        ({ content, roomId: roomIdOverride }: SendChatMessageVariables) => {
            const target = roomIdOverride ?? getRoomId();
            if (!target) throw new Error("product-sdk: no roomId given to useSendChatMessage");
            return runtime.chat.send(target, content);
        },
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        send: (content: ChatMessageContent | string, roomIdOverride?: string) =>
            mutation.mutateAsync({
                content,
                ...(roomIdOverride !== undefined ? { roomId: roomIdOverride } : {}),
            }),
    };
}
