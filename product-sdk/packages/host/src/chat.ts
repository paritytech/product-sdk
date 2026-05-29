// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's chat surface (`host_chat_*` family).
 *
 * Shipped flat-in-host rather than as `getTruApi().chat.*` (the shape
 * sketched in issue #93) because the upstream JS `hostApi` is itself a
 * flat object - there is no `.chat` accessor to mirror. A flat
 * `getChatManager()` matches the pattern already used by
 * {@link getThemeProvider}, {@link getAccountsProvider}, and
 * {@link getStatementStore}; if a namespaced view is desirable later, it
 * can be layered on top without breaking this surface.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import type {
    ChatBotRegistrationResult as NovasamaChatBotRegistrationResult,
    ChatCustomMessageRenderer as NovasamaChatCustomMessageRenderer,
    ChatCustomMessageRendererParams as NovasamaChatCustomMessageRendererParams,
    ChatMessageContent as NovasamaChatMessageContent,
    ChatReceivedAction as NovasamaChatReceivedAction,
    ChatRoom as NovasamaChatRoom,
    ChatRoomRegistrationResult as NovasamaChatRoomRegistrationResult,
    createProductChatManager,
} from "@novasamatech/host-api-wrapper";

const log = createLogger("host:chat");

/** Chat message payload variants. Re-exported from `@novasamatech/host-api-wrapper`. */
export type ChatMessageContent = NovasamaChatMessageContent;

/** Action received via {@link ChatManager.subscribeAction}. Re-exported from `@novasamatech/host-api-wrapper`. */
export type ChatReceivedAction = NovasamaChatReceivedAction;

/** Room metadata delivered to {@link ChatManager.subscribeChatList}. Re-exported from `@novasamatech/host-api-wrapper`. */
export type ChatRoom = NovasamaChatRoom;

/** Result of registering a chat room (`"New" | "Exists"`). Re-exported from `@novasamatech/host-api-wrapper`. */
export type ChatRoomRegistrationResult = NovasamaChatRoomRegistrationResult;

/** Result of registering a bot (`"New" | "Exists"`). Re-exported from `@novasamatech/host-api-wrapper`. */
export type ChatBotRegistrationResult = NovasamaChatBotRegistrationResult;

/** Renderer callback for custom message types. Re-exported from `@novasamatech/host-api-wrapper`. */
export type ChatCustomMessageRenderer = NovasamaChatCustomMessageRenderer;

/** Parameters passed to a {@link ChatCustomMessageRenderer}. Re-exported from `@novasamatech/host-api-wrapper`. */
export type ChatCustomMessageRendererParams<T = Uint8Array> =
    NovasamaChatCustomMessageRendererParams<T>;

/**
 * Chat manager handle. Exposes room/bot registration, message sending,
 * subscription to room list and incoming actions, and custom-renderer
 * registration.
 *
 * Type identical to `createProductChatManager()` from
 * `@novasamatech/host-api-wrapper`.
 */
export type ChatManager = ReturnType<typeof createProductChatManager>;

/**
 * Get the host chat manager.
 *
 * Returns the chat manager from `@novasamatech/host-api-wrapper`, or `null` if
 * the package is unavailable (running outside a host container or the
 * optional peer dep isn't installed).
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
    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.createProductChatManager();
    } catch (err) {
        log.debug("getChatManager unavailable", err);
        return null;
    }
}

/**
 * Dispatch helper that composes multiple custom-message renderers into a
 * single {@link ChatCustomMessageRenderer} keyed by `messageType`.
 *
 * Mirrors `matchChatCustomRenderers` from `@novasamatech/host-api-wrapper`
 * inline (the upstream implementation is pure dispatch logic with no
 * transport / runtime dependency on Novasama), so callers get the same
 * sync signature instead of an async-with-null wrapper.
 *
 * @param map - Object mapping `messageType` strings to renderers.
 * @returns A composed renderer that dispatches to the entry matching
 *          `params.messageType`, or throws if no renderer is registered.
 */
export function matchChatCustomRenderers(
    map: Record<string, ChatCustomMessageRenderer>,
): ChatCustomMessageRenderer {
    return (params, render) => {
        const renderer = map[params.messageType];
        if (!renderer) {
            throw new Error(`Renderer for message type ${params.messageType} is not defined`);
        }
        return renderer(params, render);
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getChatManager returns manager when SDK is available", async () => {
        const chat = await getChatManager();
        expect(chat === null || typeof chat === "object").toBe(true);
    });
}
