// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Building the messages, bodies, reactions and edit histories the host draws.
 *
 * The host draws everything in its own theme from these values: a product sends
 * no colours, fonts or layout. `Text` and the caption of `RichText` are plain,
 * with web links detected by the host; `Event`, `Call` and `Payment` draw as the
 * host's own rows and bubbles.
 *
 * @module
 */
import type {
    ChatCallRecord,
    ChatContactEvent,
    ChatFeedUpdate,
    ChatMediaItem,
    ChatMessageBody,
    ChatMessageRevision,
    ChatMessageStatus,
    ChatReactionDetail,
    ChatReactionSummary,
    ChatReplyPreview,
    ChatRoomMessage,
} from "@parity/product-sdk-host";

import { PARTICIPANT } from "./ids.js";
import { ROOM_LIMITS } from "./limits.js";

/** A plain text body, drawn without Markdown. */
export function text(value: string): ChatMessageBody {
    return { tag: "Text", value: { text: value } };
}

/** A body of media under an optional caption. */
export function richText(caption: string | undefined, media: ChatMediaItem[]): ChatMessageBody {
    return {
        tag: "RichText",
        value: { ...(caption !== undefined ? { text: caption } : {}), media },
    };
}

/** A line about the conversation, drawn as a row with the host's strings. */
export function event(value: ChatContactEvent): ChatMessageBody {
    return { tag: "Event", value };
}

/**
 * A call, drawn as the host's call bubble. The message's time is the offer and its
 * origin the caller; the host works out calling, active, ended, missed or declined
 * from these and the record.
 */
export function call(record: ChatCallRecord): ChatMessageBody {
    return { tag: "Call", value: record };
}

/** A payment, drawn as the host's transfer bubble. Its origin is the payer. */
export function payment(amount: bigint, legacy = false): ChatMessageBody {
    return { tag: "Payment", value: { amount, legacy } };
}

/** The text of a body: a `Text`, or the caption of a `RichText`. */
export function bodyText(body: ChatMessageBody): string | undefined {
    if (body.tag === "Text") return body.value.text;
    if (body.tag === "RichText") return body.value.text;
    return undefined;
}

/** What {@link message} needs; everything else has a default. */
export interface MessageInput {
    messageId: string;
    /** The participant id of the author: `"user"`, `"product"`, `"contact"` or one the product names. */
    from: string;
    /** When it was written, in milliseconds since the Unix epoch. */
    timestamp: bigint;
    body: ChatMessageBody;
    /** Default `"Sent"`. */
    status?: ChatMessageStatus;
    replyTo?: string;
    /** The quoted message, so the host draws the quote without loading it. */
    replyPreview?: ChatReplyPreview;
    editedAt?: bigint;
    reactions?: ChatReactionSummary[];
    /** The welcome message of a chat request. Default `false`. */
    request?: boolean;
}

/** A message of a room. */
export function message(input: MessageInput): ChatRoomMessage {
    return {
        messageId: input.messageId,
        origin: { participantId: input.from },
        timestamp: input.timestamp,
        body: input.body,
        status: input.status ?? "Sent",
        ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        ...(input.replyPreview ? { replyPreview: input.replyPreview } : {}),
        ...(input.editedAt !== undefined ? { editedAt: input.editedAt } : {}),
        reactions: input.reactions ?? [],
        request: input.request ?? false,
    };
}

/** The quote of `quoted` a reply carries. */
export function replyPreview(quoted: ChatRoomMessage): ChatReplyPreview {
    return { origin: quoted.origin, body: quoted.body };
}

/** One participant's reaction on a message, as a product keeps it. */
export interface ParticipantReaction {
    participantId: string;
    emoji: string;
    /** When it was placed, in milliseconds since the Unix epoch. */
    timestamp: bigint;
}

/**
 * The reaction summaries of a message: one entry per emoji, in the order the
 * emoji first appear. A reaction of another participant placed after `seenAt`
 * (when the user last saw the room's reactions) is `unseen`.
 */
export function reactionSummaries(
    reactions: ParticipantReaction[],
    options: { user?: string; seenAt?: bigint } = {},
): ChatReactionSummary[] {
    const user = options.user ?? PARTICIPANT.user;
    const byEmoji = new Map<string, ChatReactionSummary>();
    for (const reaction of reactions) {
        const entry = byEmoji.get(reaction.emoji) ?? {
            emoji: reaction.emoji,
            count: 0,
            reactedByUser: false,
            unseen: false,
        };
        entry.count += 1;
        entry.reactedByUser ||= reaction.participantId === user;
        entry.unseen ||=
            reaction.participantId !== user &&
            options.seenAt !== undefined &&
            reaction.timestamp > options.seenAt;
        byEmoji.set(reaction.emoji, entry);
    }
    return [...byEmoji.values()].slice(0, ROOM_LIMITS.reactionSummariesPerMessage);
}

/** Who reacted with what, for `reactions_query`. */
export function reactionDetails(reactions: ParticipantReaction[]): ChatReactionDetail[] {
    return reactions.map(({ participantId, emoji, timestamp }) => ({
        participantId,
        emoji,
        timestamp,
    }));
}

/** The feed updates that turn a message's reactions `before` into `after`: removals first, then placements. */
export function reactionChanges(
    messageId: string,
    before: ParticipantReaction[],
    after: ParticipantReaction[],
): ChatFeedUpdate[] {
    const key = (reaction: ParticipantReaction) =>
        `${reaction.participantId}\u0000${reaction.emoji}`;
    const had = new Set(before.map(key));
    const has = new Set(after.map(key));
    const update = (
        tag: "ReactionPlaced" | "ReactionRemoved",
        reaction: ParticipantReaction,
    ): ChatFeedUpdate => ({
        tag,
        value: { messageId, participantId: reaction.participantId, emoji: reaction.emoji },
    });
    return [
        ...before
            .filter((reaction) => !has.has(key(reaction)))
            .map((reaction) => update("ReactionRemoved", reaction)),
        ...after
            .filter((reaction) => !had.has(key(reaction)))
            .map((reaction) => update("ReactionPlaced", reaction)),
    ];
}

/** One text a message had after an edit. A revision without text removed it (media kept). */
export interface Revision {
    editedAt: bigint;
    text?: string;
}

/**
 * Every text a message had, oldest first, for `edit_history`: the original at the
 * time of the message, then each edit. Over the core's 100 texts it keeps the
 * original and the newest edits.
 */
export function editHistory(
    original: { timestamp: bigint; text?: string },
    revisions: Revision[],
): ChatMessageRevision[] {
    const ordered = [...revisions].sort((left, right) =>
        left.editedAt < right.editedAt ? -1 : left.editedAt > right.editedAt ? 1 : 0,
    );
    const kept = ordered.slice(
        Math.max(0, ordered.length - (ROOM_LIMITS.editHistoryRevisions - 1)),
    );
    return [
        {
            editedAt: original.timestamp,
            ...(original.text !== undefined ? { text: original.text } : {}),
        },
        ...kept.map((revision) => ({
            editedAt: revision.editedAt,
            ...(revision.text !== undefined ? { text: revision.text } : {}),
        })),
    ];
}

/** The newest revision, or `undefined` for a message never edited. */
export function latestRevision(revisions: Revision[]): Revision | undefined {
    return revisions.reduce<Revision | undefined>(
        (latest, revision) => (!latest || revision.editedAt > latest.editedAt ? revision : latest),
        undefined,
    );
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    test("message fills the defaults", () => {
        expect(
            message({ messageId: "m", from: "product", timestamp: 5n, body: text("hi") }),
        ).toEqual({
            messageId: "m",
            origin: { participantId: "product" },
            timestamp: 5n,
            body: { tag: "Text", value: { text: "hi" } },
            status: "Sent",
            reactions: [],
            request: false,
        });
    });

    describe("reactions", () => {
        const reactions: ParticipantReaction[] = [
            { participantId: "contact", emoji: "👍", timestamp: 10n },
            { participantId: "user", emoji: "👍", timestamp: 11n },
            { participantId: "contact", emoji: "🎉", timestamp: 30n },
        ];

        test("one summary per emoji, unseen after the user last looked", () => {
            expect(reactionSummaries(reactions, { seenAt: 20n })).toEqual([
                { emoji: "👍", count: 2, reactedByUser: true, unseen: false },
                { emoji: "🎉", count: 1, reactedByUser: false, unseen: true },
            ]);
        });

        test("without seenAt nothing is unseen", () => {
            expect(reactionSummaries(reactions).some((summary) => summary.unseen)).toBe(false);
        });

        test("changes remove then place", () => {
            const after: ParticipantReaction[] = [
                { participantId: "user", emoji: "❤️", timestamp: 40n },
                { participantId: "contact", emoji: "👍", timestamp: 10n },
            ];
            expect(reactionChanges("m", reactions, after)).toEqual([
                {
                    tag: "ReactionRemoved",
                    value: { messageId: "m", participantId: "user", emoji: "👍" },
                },
                {
                    tag: "ReactionRemoved",
                    value: { messageId: "m", participantId: "contact", emoji: "🎉" },
                },
                {
                    tag: "ReactionPlaced",
                    value: { messageId: "m", participantId: "user", emoji: "❤️" },
                },
            ]);
        });
    });

    describe("editHistory", () => {
        test("the original first, then each edit oldest first", () => {
            expect(
                editHistory({ timestamp: 1n, text: "a" }, [
                    { editedAt: 3n, text: "c" },
                    { editedAt: 2n, text: "b" },
                ]),
            ).toEqual([
                { editedAt: 1n, text: "a" },
                { editedAt: 2n, text: "b" },
                { editedAt: 3n, text: "c" },
            ]);
        });

        test("over 100 texts the original and the newest edits are kept", () => {
            const revisions = Array.from({ length: 150 }, (_, index) => ({
                editedAt: BigInt(index + 2),
                text: `${index}`,
            }));
            const history = editHistory({ timestamp: 1n, text: "first" }, revisions);
            expect(history).toHaveLength(100);
            expect(history[0]).toEqual({ editedAt: 1n, text: "first" });
            expect(history[99]).toEqual({ editedAt: 151n, text: "149" });
        });
    });

    test("bodyText reads a text or a caption", () => {
        expect(bodyText(text("x"))).toBe("x");
        expect(bodyText(richText("cap", []))).toBe("cap");
        expect(bodyText(event("LeftChat"))).toBeUndefined();
    });
}
