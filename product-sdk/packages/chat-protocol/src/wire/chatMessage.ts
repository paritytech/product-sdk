// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { _void, compact, Enum, Option, Struct, str, u8, u32, u64, Vector } from "scale-ts";

import { Bytes32, decodeLenient, VecU8 } from "./scale.js";

/** Endpoint of a HOP node. */
export const NodeEndpointCodec = Enum({ WssUrl: str }, [0]);

const GeneralFileMetaCodec = Struct({ mimeType: str, fileSize: u32 });

/** Attachment metadata. Thumbnails are UTF-8 BlurHash strings. */
export const FileMetaCodec = Enum(
    {
        General: GeneralFileMetaCodec,
        Image: Struct({
            general: GeneralFileMetaCodec,
            width: u32,
            height: u32,
            thumbnail: Option(VecU8),
        }),
        Video: Struct({ general: GeneralFileMetaCodec, duration: u32, thumbnail: Option(VecU8) }),
    },
    [0, 1, 2],
);

/** An attachment stored on a HOP node. */
export const FileVariantCodec = Enum(
    {
        P2PMixnet: Struct({
            identifier: VecU8,
            claimTicket: VecU8,
            nodeEndpoint: NodeEndpointCodec,
            meta: FileMetaCodec,
        }),
    },
    [0],
);

/** An attachment as the wire carries it. */
export type FileVariant = ReturnType<typeof FileVariantCodec.dec>;

/** Text with optional attachments. An empty attachment list is sent as `undefined`. */
export const RichTextContentCodec = Struct({
    text: Option(str),
    attachments: Option(Vector(FileVariantCodec)),
});

/** Push token platform: 0 Android, 1 iOS, 2 iOS VoIP. */
export const TOKEN_PLATFORM = { Android: 0, Ios: 1, IosVoip: 2 } as const;

/** Call purpose: 0 audio, 1 video. */
export const CALL_PURPOSE = { Audio: 0, Video: 1 } as const;

/**
 * `ChatMessageStatementContent` (Appendix A.10). Index 2 is the iOS legacy
 * `Send`, decoded and never sent; index 6 is unused.
 */
export const ChatContentCodec = Enum(
    {
        Text: str,
        Token: Struct({ token: VecU8, platform: u8 }),
        Send: Struct({ amount: compact, blockHash: Bytes32, extrinsicHash: Bytes32 }),
        ContactAdded: _void,
        Reacted: Struct({ messageId: str, emoji: str }),
        ReactionRemoved: Struct({ messageId: str, emoji: str }),
        Reply: Struct({ messageId: str, ownContent: RichTextContentCodec }),
        DataChannelOffer: Struct({ sdp: VecU8, purpose: u8 }),
        DataChannelAnswer: Struct({ offerMessageId: str, sdp: VecU8 }),
        DataChannelIceCandidate: Struct({ offerMessageId: str, sdp: VecU8 }),
        DataChannelClosed: Struct({ offerMessageId: str }),
        Edited: Struct({ messageId: str, newContent: RichTextContentCodec }),
        LeftChat: _void,
        ChatAccepted: Struct({ requestId: str }),
        RichText: RichTextContentCodec,
        CoinagePayment: Struct({ totalValue: compact, coinKeys: Vector(VecU8) }),
        DeviceAdded: Struct({ statementAccountId: VecU8, encryptionPublicKey: VecU8 }),
        DeviceRemoved: Struct({ statementAccountId: VecU8 }),
        CompactionCommit: Struct({
            claimIdentifier: VecU8,
            claimTicket: VecU8,
            node: NodeEndpointCodec,
        }),
        DeviceChatAccepted: Struct({
            requestId: str,
            device: Struct({ statementAccountId: Bytes32, encryptionPublicKey: Bytes32 }),
        }),
    },
    [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
);

/** Decoded chat message content. */
export type ChatContent = ReturnType<typeof ChatContentCodec.dec>;

/** Content tag names. */
export type ChatContentTag = ChatContent["tag"];

/** `ChatMessageStatement { id, timestamp, versioned: V1 { content } }`. */
export const ChatMessageCodec = Struct({
    id: str,
    timestamp: u64,
    versioned: Enum({ V1: Struct({ content: ChatContentCodec }) }, [0]),
});

const AlwaysDecodableCodec = Struct({ id: str, timestamp: u64 });

/** A chat message as the engine handles it. */
export interface ChatMessage {
    id: string;
    /** Sender wall clock, unix milliseconds. */
    timestamp: bigint;
    content: ChatContent;
}

/** A message whose content this version cannot decode. Its raw bytes are kept for a later re-parse. */
export interface UnsupportedChatMessage {
    id: string;
    timestamp: bigint;
    raw: Uint8Array;
}

/** Result of decoding one encoded message. */
export type DecodedChatMessage =
    | { kind: "Known"; message: ChatMessage }
    | { kind: "Unsupported"; message: UnsupportedChatMessage };

/** SCALE encoding of `message` (always version 1). */
export function encodeChatMessage(message: ChatMessage): Uint8Array {
    return ChatMessageCodec.enc({
        id: message.id,
        timestamp: message.timestamp,
        versioned: { tag: "V1", value: { content: message.content } },
    });
}

/**
 * Decodes a message, ignoring trailing bytes as Android does. Content of an
 * unknown version or variant becomes `Unsupported` with the whole encoding
 * kept. Throws only when even the id and timestamp cannot be read.
 */
export function decodeChatMessage(bytes: Uint8Array): DecodedChatMessage {
    try {
        const decoded = decodeLenient(ChatMessageCodec, bytes);
        return {
            kind: "Known",
            message: {
                id: decoded.id,
                timestamp: decoded.timestamp,
                content: decoded.versioned.value.content,
            },
        };
    } catch {
        const prefix = decodeLenient(AlwaysDecodableCodec, bytes);
        return {
            kind: "Unsupported",
            message: { id: prefix.id, timestamp: prefix.timestamp, raw: bytes },
        };
    }
}

/** Device info carried by `DeviceChatAccepted` and V2 chat requests. */
export const DeviceInfoCodec = Struct({
    statementAccountId: Bytes32,
    encryptionPublicKey: Bytes32,
});
