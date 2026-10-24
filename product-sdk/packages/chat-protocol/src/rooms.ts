// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The protocol's contents as Chat Extension v2 draws them.
 *
 * A product that runs the person-to-person protocol and serves its
 * conversations as rooms turns each received content into the body the host
 * draws: a text, media under a caption, a row about the conversation, a call
 * bubble or a payment bubble. A call offer is drawn from its answer and close
 * messages, which the product gathers as {@link CallFacts}.
 *
 * @module
 */
import type {
    ChatContactEvent,
    ChatMediaItem,
    ChatMediaMeta,
    ChatMessageBody,
} from "@parity/product-sdk-host";

import { fromHex, fromUtf8, toHex, utf8 } from "./bytes.js";
import { CALL_PURPOSE, type ChatContent, type FileVariant } from "./wire/chatMessage.js";

/**
 * A native attachment as a media item the host draws from its HOP file. The core
 * checks the node when the host opens it. No file name travels on the wire, so a
 * general file is named `file`.
 */
export function attachmentItem(attachment: FileVariant): ChatMediaItem {
    const file = attachment.value;
    const general = file.meta.tag === "General" ? file.meta.value : file.meta.value.general;
    const thumbnail = file.meta.tag === "General" ? undefined : file.meta.value.thumbnail;
    const meta: ChatMediaMeta = {
        mimeType: general.mimeType,
        sizeBytes: BigInt(general.fileSize),
        ...(file.meta.tag === "Image"
            ? { width: file.meta.value.width, height: file.meta.value.height }
            : {}),
        // The native chat sends the duration of a video in whole seconds.
        ...(file.meta.tag === "Video"
            ? { durationMs: BigInt(file.meta.value.duration) * 1000n }
            : {}),
        ...(thumbnail ? { placeholder: fromUtf8(thumbnail) } : {}),
    };
    const resource = {
        tag: "Hop" as const,
        value: {
            identifier: `0x${toHex(file.identifier)}` as const,
            ticket: `0x${toHex(file.claimTicket)}` as const,
            node: file.nodeEndpoint.value,
            size: BigInt(general.fileSize),
        },
    };
    switch (file.meta.tag) {
        case "Image":
            return { tag: "Image", value: { resource, meta } };
        case "Video":
            return { tag: "Video", value: { resource, meta } };
        default:
            return { tag: "File", value: { resource, meta, fileName: "file" } };
    }
}

/**
 * A media item the user sent, which the host uploaded to HOP, as the native
 * attachment; `undefined` for a resource that is no HOP file. The duration of a
 * video goes in whole seconds, as the native chat sends it.
 */
export function attachmentOf(item: ChatMediaItem): FileVariant | undefined {
    const { resource, meta } = item.value;
    if (resource.tag !== "Hop") return undefined;
    const general = { mimeType: meta.mimeType, fileSize: Number(resource.value.size) };
    const thumbnail = meta.placeholder ? utf8(meta.placeholder) : undefined;
    const fileMeta =
        item.tag === "Image"
            ? {
                  tag: "Image" as const,
                  value: { general, width: meta.width ?? 0, height: meta.height ?? 0, thumbnail },
              }
            : item.tag === "Video"
              ? {
                    tag: "Video" as const,
                    value: {
                        general,
                        duration: Math.round(Number(meta.durationMs ?? 0n) / 1000),
                        thumbnail,
                    },
                }
              : { tag: "General" as const, value: general };
    return {
        tag: "P2PMixnet",
        value: {
            identifier: fromHex(resource.value.identifier),
            claimTicket: fromHex(resource.value.ticket),
            nodeEndpoint: { tag: "WssUrl", value: resource.value.node },
            meta: fileMeta,
        },
    };
}

/** What answered and closed a call offer, from its `DataChannelAnswer` and `DataChannelClosed` messages. */
export interface CallFacts {
    /** Time of the earliest answer. */
    answeredAt?: bigint;
    /** The earliest close: its time and whether the user sent it. */
    closed?: { at: bigint; byUser: boolean };
}

/** A call message as {@link addCallFact} reads it. */
export interface CallMessageFact {
    /** Missing for a content this version cannot read. */
    content?: ChatContent;
    timestamp: bigint;
    /** The user sent it. */
    outgoing: boolean;
}

/** Adds an answer or close message of a call to the facts of its offer. */
export function addCallFact(facts: CallFacts, message: CallMessageFact): CallFacts {
    const tag = message.content?.tag;
    if (tag === "DataChannelAnswer") {
        if (facts.answeredAt === undefined || message.timestamp < facts.answeredAt)
            return { ...facts, answeredAt: message.timestamp };
    } else if (tag === "DataChannelClosed") {
        if (!facts.closed || message.timestamp < facts.closed.at)
            return { ...facts, closed: { at: message.timestamp, byUser: message.outgoing } };
    }
    return facts;
}

/** The offer a call message answers or closes, or `undefined` for any other content. */
export function callOfferOf(content: ChatContent | undefined): string | undefined {
    if (content?.tag === "DataChannelAnswer" || content?.tag === "DataChannelClosed")
        return content.value.offerMessageId;
    return undefined;
}

/** How {@link contentBody} draws a content beyond the content itself. */
export interface ContentBodyOptions {
    /** The newest edit of the message: its text replaces the text or caption. */
    edit?: { text?: string };
    /** The answer and close of a call offer. */
    call?: CallFacts;
}

/**
 * The body a content shows. A content this version cannot read, or one with no
 * row of its own, shows as `Unsupported`; a compaction commit whose batch could
 * not be loaded shows as `Unavailable`.
 */
export function contentBody(
    content: ChatContent | undefined,
    options: ContentBodyOptions = {},
): ChatMessageBody {
    const { edit, call = {} } = options;
    const text = (value: string): ChatMessageBody => ({ tag: "Text", value: { text: value } });
    const event = (value: ChatContactEvent): ChatMessageBody => ({ tag: "Event", value });
    if (!content) return event("Unsupported");
    switch (content.tag) {
        case "Text":
            return text(edit?.text ?? content.value);
        case "Reply":
        case "RichText": {
            const own = content.tag === "Reply" ? content.value.ownContent : content.value;
            const attachments = own.attachments ?? [];
            const caption = edit ? edit.text : own.text;
            if (attachments.length === 0) return text(caption ?? "");
            return {
                tag: "RichText",
                value: {
                    ...(caption ? { text: caption } : {}),
                    media: attachments.map(attachmentItem),
                },
            };
        }
        case "LeftChat":
            return event("LeftChat");
        case "ContactAdded":
            return event("ContactAdded");
        case "ChatAccepted":
        case "DeviceChatAccepted":
            return event("RequestAccepted");
        case "DataChannelOffer":
            return {
                tag: "Call",
                value: {
                    video: content.value.purpose === CALL_PURPOSE.Video,
                    ...(call.answeredAt !== undefined ? { answeredAt: call.answeredAt } : {}),
                    ...(call.closed ? { closed: call.closed } : {}),
                },
            };
        case "CoinagePayment":
            return {
                tag: "Payment",
                value: { amount: BigInt(content.value.totalValue), legacy: false },
            };
        case "Send":
            return {
                tag: "Payment",
                value: { amount: BigInt(content.value.amount), legacy: true },
            };
        case "CompactionCommit":
            return event("Unavailable");
        default:
            return event("Unsupported");
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    const attachment: FileVariant = {
        tag: "P2PMixnet",
        value: {
            identifier: new Uint8Array(32).fill(1),
            claimTicket: new Uint8Array(32).fill(2),
            nodeEndpoint: { tag: "WssUrl", value: "wss://hop" },
            meta: {
                tag: "Video",
                value: {
                    general: { mimeType: "video/mp4", fileSize: 10 },
                    duration: 3,
                    thumbnail: utf8("LKO2"),
                },
            },
        },
    };

    test("an attachment round-trips through a media item, the video's duration in seconds", () => {
        const item = attachmentItem(attachment);
        expect(item.tag).toBe("Video");
        expect(item.value.meta.durationMs).toBe(3000n);
        expect(attachmentOf(item)).toEqual(attachment);
    });

    test("a call offer draws from its earliest answer and close", () => {
        let facts: CallFacts = {};
        facts = addCallFact(facts, {
            content: {
                tag: "DataChannelAnswer",
                value: { offerMessageId: "c", sdp: new Uint8Array() },
            },
            timestamp: 9n,
            outgoing: false,
        });
        facts = addCallFact(facts, {
            content: {
                tag: "DataChannelAnswer",
                value: { offerMessageId: "c", sdp: new Uint8Array() },
            },
            timestamp: 5n,
            outgoing: false,
        });
        facts = addCallFact(facts, {
            content: { tag: "DataChannelClosed", value: { offerMessageId: "c" } },
            timestamp: 20n,
            outgoing: true,
        });
        expect(
            contentBody(
                { tag: "DataChannelOffer", value: { sdp: new Uint8Array(), purpose: 1 } },
                { call: facts },
            ),
        ).toEqual({
            tag: "Call",
            value: { video: true, answeredAt: 5n, closed: { at: 20n, byUser: true } },
        });
        expect(callOfferOf({ tag: "DataChannelClosed", value: { offerMessageId: "c" } })).toBe("c");
    });

    test("an edit replaces the text, and unknown content is Unsupported", () => {
        expect(contentBody({ tag: "Text", value: "old" }, { edit: { text: "new" } })).toEqual({
            tag: "Text",
            value: { text: "new" },
        });
        expect(contentBody(undefined)).toEqual({ tag: "Event", value: "Unsupported" });
        expect(
            contentBody({ tag: "Token", value: { token: new Uint8Array(), platform: 0 } }),
        ).toEqual({
            tag: "Event",
            value: "Unsupported",
        });
    });
}
