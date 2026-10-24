// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Handling what the user does in a product-source room.
 *
 * The host sends every user action of a product-source room to `user_action`. It
 * draws a sent message as `Preparing` at once and replaces it with the product's
 * answer, so `NewMessage` (and `SendPayment`) answers `MessageCreated` with the
 * message as the product stored it; every other action answers `Acknowledged`. A
 * host may choose the id of a message the user sends and ask again with the same
 * id after a time-out, so a repeated `NewMessage` or `SendPayment` answers what was
 * stored the first time instead of sending twice.
 *
 * @module
 */
import {
    type ChatMessageBody,
    type ChatRoomMessage,
    type ChatUserAction,
    type ProductChatUserActionItem,
    UserActionRejectedError,
} from "@parity/product-sdk-host";

type ActionValue<Tag extends ChatUserAction["tag"]> = Extract<
    ChatUserAction,
    { tag: Tag }
>["value"];

/** One handler per user action. A missing handler rejects the action with a reason the user sees. */
export interface UserActionHandlers {
    /** The user sent a message: store it (under `messageId` when the host chose one) and send it. */
    newMessage?(value: ActionValue<"NewMessage">): Promise<ChatRoomMessage>;
    /** The user edited a message of their own. */
    editMessage?(value: { messageId: string; body: ChatMessageBody }): Promise<void>;
    reactionPlaced?(value: { messageId: string; emoji: string }): Promise<void>;
    reactionRemoved?(value: { messageId: string; emoji: string }): Promise<void>;
    /** The user saw this message, the newest on screen. Sent only when the room sets `reportSeen`. */
    seen?(value: { messageId: string }): Promise<void>;
    /** Contact rooms (the person chat product): the user accepted the chat request. */
    acceptRequest?(): Promise<void>;
    declineRequest?(): Promise<void>;
    block?(): Promise<void>;
    unblock?(): Promise<void>;
    leave?(): Promise<void>;
    /** Contact rooms (the person chat product): the user paid the contact with coins the host reserved. */
    sendPayment?(value: ActionValue<"SendPayment">): Promise<ChatRoomMessage>;
    /**
     * The message already stored under a message id, so a repeated `NewMessage` or
     * `SendPayment` answers it instead of sending again.
     */
    existing?(messageId: string): Promise<ChatRoomMessage | undefined>;
    /** The reason shown for an action no handler takes. Default "This chat does not do that". */
    rejection?: string;
}

/**
 * A `RoomSource.userAction` from one handler per action.
 *
 * @example
 * ```ts
 * userAction: userActions({
 *     newMessage: async ({ body, messageId, timestamp }) => backend.send(roomId, body, messageId, timestamp),
 *     existing: (messageId) => backend.find(roomId, messageId),
 * }),
 * ```
 */
export function userActions(
    handlers: UserActionHandlers,
): (action: ChatUserAction) => Promise<ProductChatUserActionItem> {
    const reject = (): never => {
        throw new UserActionRejectedError(handlers.rejection ?? "This chat does not do that");
    };
    const acknowledge = async (
        work: Promise<void> | undefined,
    ): Promise<ProductChatUserActionItem> => {
        if (!work) reject();
        await work;
        return { tag: "Acknowledged" };
    };
    const created = async (
        messageId: string | undefined,
        send: (() => Promise<ChatRoomMessage>) | undefined,
    ): Promise<ProductChatUserActionItem> => {
        if (!send) return reject();
        const known = messageId !== undefined ? await handlers.existing?.(messageId) : undefined;
        return { tag: "MessageCreated", value: known ?? (await send()) };
    };

    return async (action) => {
        switch (action.tag) {
            case "NewMessage":
                return created(
                    action.value.messageId,
                    handlers.newMessage &&
                        (() => handlers.newMessage?.(action.value) as Promise<ChatRoomMessage>),
                );
            case "SendPayment":
                return created(
                    action.value.messageId,
                    handlers.sendPayment &&
                        (() => handlers.sendPayment?.(action.value) as Promise<ChatRoomMessage>),
                );
            case "EditMessage":
                return acknowledge(handlers.editMessage?.(action.value));
            case "ReactionPlaced":
                return acknowledge(handlers.reactionPlaced?.(action.value));
            case "ReactionRemoved":
                return acknowledge(handlers.reactionRemoved?.(action.value));
            case "Seen":
                return acknowledge(handlers.seen?.(action.value));
            case "AcceptRequest":
                return acknowledge(handlers.acceptRequest?.());
            case "DeclineRequest":
                return acknowledge(handlers.declineRequest?.());
            case "Block":
                return acknowledge(handlers.block?.());
            case "Unblock":
                return acknowledge(handlers.unblock?.());
            case "Leave":
                return acknowledge(handlers.leave?.());
        }
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { message, text } = await import("./builders.js");

    test("a new message answers the stored message, and a repeat answers it again without sending", async () => {
        const stored = new Map<string, ChatRoomMessage>();
        let sends = 0;
        const handle = userActions({
            async newMessage({ body, messageId }) {
                sends++;
                const sent = message({
                    messageId: messageId ?? "own",
                    from: "user",
                    timestamp: 1n,
                    body,
                });
                stored.set(sent.messageId, sent);
                return sent;
            },
            existing: async (messageId) => stored.get(messageId),
        });
        const action: ChatUserAction = {
            tag: "NewMessage",
            value: { body: text("hi"), messageId: "host-id" },
        };
        const first = await handle(action);
        const again = await handle(action);
        expect(first).toEqual(again);
        expect(first.tag === "MessageCreated" && first.value.messageId).toBe("host-id");
        expect(sends).toBe(1);
    });

    test("other actions are acknowledged", async () => {
        const seen: string[] = [];
        const handle = userActions({ seen: async ({ messageId }) => void seen.push(messageId) });
        expect(await handle({ tag: "Seen", value: { messageId: "m" } })).toEqual({
            tag: "Acknowledged",
        });
        expect(seen).toEqual(["m"]);
    });

    test("an action without a handler is rejected with the reason", async () => {
        const handle = userActions({ rejection: "Read only" });
        await expect(handle({ tag: "Block" })).rejects.toThrow(UserActionRejectedError);
        await expect(handle({ tag: "Block" })).rejects.toThrow("Read only");
    });
}
