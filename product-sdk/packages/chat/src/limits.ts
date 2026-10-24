// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The bounds, rates and waits of Chat Extension v2 and its additions.
 *
 * The core enforces every bound before a host sees a value, and refuses a value
 * over one: a message text or `Custom` payload with `MessageTooLarge`, a rate with
 * `RateLimited`, anything else with `Unknown` naming the field. These checks let a
 * product find out first. They measure only: normalising and screening stay the
 * core's job.
 *
 * @module
 */
import type { ChatMessageBody, ChatRoomMessage, ChatRoomPreview } from "@parity/product-sdk-host";

/** The bounds the core enforces. Text sizes are UTF-8 bytes. */
export const ROOM_LIMITS = {
    /** `room_id`, `message_id`, `participant_id`, `action_id`, `message_type`, `call_id`, `caller`. */
    identifierBytes: 256,
    /** `name`, `alt`, `file_name`, `mime_type`, media `placeholder`, emoji, input hint. */
    displayTextBytes: 256,
    /** A room's `description`. */
    descriptionBytes: 1024,
    /** A message's text or caption. */
    messageTextBytes: 16 * 1024,
    /** A `Custom` payload of `post_message`. */
    customPayloadBytes: 256 * 1024,
    /** A HOP file or attachment. */
    hopFileBytes: 128 * 1024 * 1024,
    /** Media of one message, and buttons of one `Actions` content. */
    mediaPerMessage: 32,
    /** Reaction summaries of one message. */
    reactionSummariesPerMessage: 64,
    /** What `messages_query` asks for, and the most a page holds. */
    pageSize: { min: 1, max: 100 },
    /** A paging or search cursor. */
    cursorBytes: 1024,
    /** What `search_query` asks for. */
    searchPageSize: { min: 1, max: 50 },
    /** Texts an edit history holds. */
    editHistoryRevisions: 100,
    /** What the user opened, as `open_link` gives it. */
    openLinkPayloadBytes: { min: 1, max: 8 * 1024 },
    /** A call media signal. */
    callSignalBytes: { min: 1, max: 64 * 1024 },
    /** A contact's username. */
    usernameBytes: { min: 1, max: 256 },
    /** Messages the host keeps of one product-source room. */
    hostKeptMessages: 500,
} as const;

/** Calls per second per room the core allows. */
export const ROOM_RATES = {
    updateFeed: 20,
    setPreview: 5,
    setCall: 2,
    setContact: 5,
} as const;

/** How long the host waits for an answer before it applies its default. */
export const QUERY_WAITS_MS = {
    messages: 10_000,
    /** `user_action` with `NewMessage` or `SendPayment`: then the message is marked `Failed`. */
    userActionSend: 30_000,
    /** Any other `user_action`: then the change is reverted. */
    userAction: 10_000,
    reactions: 5_000,
    editHistory: 5_000,
    search: 10_000,
    openLink: 90_000,
} as const;

const encoder = new TextEncoder();

/** UTF-8 length of `text` in bytes. */
export function utf8Bytes(text: string): number {
    return encoder.encode(text).length;
}

/**
 * A bound a value breaks. `MessageTooLarge` is what the core answers for a text
 * over its bound; any other bound it answers with `Unknown` naming `field`.
 */
export interface LimitViolation {
    field: string;
    bound: number;
    actual: number;
    answer: "MessageTooLarge" | "Unknown";
}

function over(
    field: string,
    bound: number,
    actual: number,
    answer: LimitViolation["answer"] = "Unknown",
): LimitViolation | undefined {
    return actual > bound ? { field, bound, actual, answer } : undefined;
}

/** Checks an identifier (`room_id`, `message_id`, ...) against its 256-byte bound. */
export function checkIdentifier(value: string, field: string): LimitViolation | undefined {
    return over(field, ROOM_LIMITS.identifierBytes, utf8Bytes(value));
}

/** Checks display text (`name`, `alt`, emoji, ...) against its 256-byte bound. */
export function checkDisplayText(value: string, field: string): LimitViolation | undefined {
    return over(field, ROOM_LIMITS.displayTextBytes, utf8Bytes(value));
}

/** The first bound a message body breaks. */
export function checkBody(body: ChatMessageBody): LimitViolation | undefined {
    if (body.tag === "Text")
        return over(
            "text",
            ROOM_LIMITS.messageTextBytes,
            utf8Bytes(body.value.text),
            "MessageTooLarge",
        );
    if (body.tag !== "RichText") return undefined;
    if (body.value.text !== undefined) {
        const text = over(
            "text",
            ROOM_LIMITS.messageTextBytes,
            utf8Bytes(body.value.text),
            "MessageTooLarge",
        );
        if (text) return text;
    }
    const media = over("media", ROOM_LIMITS.mediaPerMessage, body.value.media.length);
    if (media) return media;
    for (const item of body.value.media) {
        const meta = item.value.meta;
        const problem =
            checkDisplayText(meta.mimeType, "mime_type") ??
            (meta.alt !== undefined ? checkDisplayText(meta.alt, "alt") : undefined) ??
            (meta.placeholder !== undefined
                ? checkDisplayText(meta.placeholder, "placeholder")
                : undefined) ??
            (item.tag === "File" ? checkDisplayText(item.value.fileName, "file_name") : undefined);
        if (problem) return problem;
    }
    return undefined;
}

/** The first bound a message breaks, its reply quote included. */
export function checkMessage(message: ChatRoomMessage): LimitViolation | undefined {
    const identifiers =
        checkIdentifier(message.messageId, "message_id") ??
        checkIdentifier(message.origin.participantId, "participant_id") ??
        (message.replyTo !== undefined ? checkIdentifier(message.replyTo, "reply_to") : undefined);
    if (identifiers) return identifiers;
    const reactions = over(
        "reactions",
        ROOM_LIMITS.reactionSummariesPerMessage,
        message.reactions.length,
    );
    if (reactions) return reactions;
    const emoji = new Set<string>();
    for (const reaction of message.reactions) {
        const text = checkDisplayText(reaction.emoji, "emoji");
        if (text) return text;
        if (emoji.has(reaction.emoji))
            return { field: "reactions", bound: 1, actual: 2, answer: "Unknown" };
        emoji.add(reaction.emoji);
    }
    return (
        checkBody(message.body) ??
        (message.replyPreview ? checkBody(message.replyPreview.body) : undefined)
    );
}

/** The first bound a chat-list preview breaks, in the messages it carries. */
export function checkPreview(preview: ChatRoomPreview): LimitViolation | undefined {
    for (const message of [preview.lastMessage, preview.lastCall, preview.lastReaction?.message]) {
        const problem = message ? checkMessage(message) : undefined;
        if (problem) return problem;
    }
    if (preview.lastReaction) return checkDisplayText(preview.lastReaction.emoji, "emoji");
    return undefined;
}

/** A page size the host may ask, clamped to 1 to 100. */
export function clampPageSize(pageSize: number): number {
    return Math.max(ROOM_LIMITS.pageSize.min, Math.min(ROOM_LIMITS.pageSize.max, pageSize));
}

/** A search page size, clamped to 1 to 50. */
export function clampSearchPageSize(pageSize: number): number {
    return Math.max(
        ROOM_LIMITS.searchPageSize.min,
        Math.min(ROOM_LIMITS.searchPageSize.max, pageSize),
    );
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    const message = (text: string): ChatRoomMessage => ({
        messageId: "m",
        origin: { participantId: "product" },
        timestamp: 1n,
        body: { tag: "Text", value: { text } },
        status: "Sent",
        reactions: [],
        request: false,
    });

    test("a text is measured in UTF-8 bytes", () => {
        expect(utf8Bytes("é")).toBe(2);
        expect(checkMessage(message("a".repeat(16 * 1024)))).toBeUndefined();
        expect(checkMessage(message("é".repeat(8 * 1024 + 1)))).toEqual({
            field: "text",
            bound: 16 * 1024,
            actual: 16 * 1024 + 2,
            answer: "MessageTooLarge",
        });
    });

    test("a repeated emoji in the reactions is refused", () => {
        const twice = message("hi");
        twice.reactions = [
            { emoji: "👍", count: 1, reactedByUser: false, unseen: false },
            { emoji: "👍", count: 1, reactedByUser: true, unseen: false },
        ];
        expect(checkMessage(twice)?.field).toBe("reactions");
    });

    test("too many media items is refused naming media", () => {
        const media = Array.from({ length: 33 }, () => ({
            tag: "Image" as const,
            value: {
                resource: {
                    tag: "Hop" as const,
                    value: {
                        identifier: "0x00" as const,
                        ticket: "0x00" as const,
                        node: "wss://n",
                        size: 1n,
                    },
                },
                meta: { mimeType: "image/png" },
            },
        }));
        expect(checkBody({ tag: "RichText", value: { media } })?.field).toBe("media");
    });

    test("page sizes clamp to the RFC's bounds", () => {
        expect(clampPageSize(0)).toBe(1);
        expect(clampPageSize(500)).toBe(100);
        expect(clampSearchPageSize(80)).toBe(50);
    });
}
