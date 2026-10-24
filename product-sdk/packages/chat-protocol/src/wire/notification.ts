// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { _void, compact, Enum, Struct, str, u8, u64 } from "scale-ts";

import { ChatContentCodec, DeviceInfoCodec, RichTextContentCodec } from "./chatMessage.js";
import { VecU8 } from "./scale.js";

/** Stripped content: the pushable variants, with coin keys dropped. Indices mirror the content enum. */
export const StrippedContentCodec = Enum(
    {
        Text: str,
        ContactAdded: _void,
        Reacted: Struct({ messageId: str, emoji: str }),
        Reply: Struct({ messageId: str, ownContent: RichTextContentCodec }),
        DataChannelOffer: Struct({ sdp: VecU8, purpose: u8 }),
        ChatAccepted: Struct({ requestId: str }),
        RichText: RichTextContentCodec,
        CoinagePayment: Struct({ totalBalance: compact }),
        DeviceChatAccepted: Struct({ requestId: str, device: DeviceInfoCodec }),
    },
    [0, 3, 4, 7, 8, 14, 15, 16, 20],
);

/** `NotificationMessagePayload` (Appendix A.15.1). */
export const NotificationPayloadCodec = Struct({
    id: str,
    timestamp: u64,
    versioned: Enum(
        { V1: Enum({ Stripped: StrippedContentCodec, Full: ChatContentCodec }, [0, 1]) },
        [0],
    ),
});

/** Decoded notification payload. */
export type NotificationPayload = ReturnType<typeof NotificationPayloadCodec.dec>;

/** Largest Full payload; above it the Stripped form is sent. */
export const PUSH_PAYLOAD_BUDGET = 1800;

/** Contents a sender pushes (A.15.4): what the receiver can show as a notification. */
export const PUSHED_CONTENT = new Set([
    "Text",
    "ContactAdded",
    "Reacted",
    "Reply",
    "DataChannelOffer",
    "ChatAccepted",
    "RichText",
    "CoinagePayment",
    "DeviceChatAccepted",
]);

type Content = Parameters<typeof ChatContentCodec.enc>[0];
type Stripped = Parameters<typeof StrippedContentCodec.enc>[0];

function stripped(content: Content): Stripped | undefined {
    switch (content.tag) {
        case "Text":
        case "ContactAdded":
        case "Reacted":
        case "Reply":
        case "DataChannelOffer":
        case "ChatAccepted":
        case "RichText":
        case "DeviceChatAccepted":
            return content as Stripped;
        case "CoinagePayment":
            return { tag: "CoinagePayment", value: { totalBalance: content.value.totalValue } };
        default:
            return undefined;
    }
}

/** The notification payload of a message: Full when it fits the budget, else Stripped (A.15.1). */
export function encodeNotificationPayload(
    id: string,
    timestamp: bigint,
    content: Content,
): Uint8Array | undefined {
    const full = NotificationPayloadCodec.enc({
        id,
        timestamp,
        versioned: { tag: "V1", value: { tag: "Full", value: content } },
    });
    if (full.length <= PUSH_PAYLOAD_BUDGET) return full;
    const value = stripped(content);
    return value
        ? NotificationPayloadCodec.enc({
              id,
              timestamp,
              versioned: { tag: "V1", value: { tag: "Stripped", value } },
          })
        : undefined;
}
