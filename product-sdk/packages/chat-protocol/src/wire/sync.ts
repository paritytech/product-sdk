// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { Enum, Struct, u8, u32, u64, Vector } from "scale-ts";

import { ChatMessageCodec } from "./chatMessage.js";
import { Bytes32 } from "./scale.js";

/** Outgoing status: 0 NEW, 1 SENT, 2 DELIVERED. Incoming: 0 NEW, 1 SEEN. */
export const LocalStatusCodec = Enum({ Outgoing: u8, Incoming: u8 }, [0, 1]);

/** `LocalMessage`: a stored message as device sync and the migration export carry it (Appendix A.17). */
export const LocalMessageCodec = Struct({
    remote: ChatMessageCodec,
    peerId: Bytes32,
    status: LocalStatusCodec,
    order: u64,
});

/** Decoded local message. */
export type LocalMessage = ReturnType<typeof LocalMessageCodec.dec>;

const ChatIdCodec = Enum({ Contact: Bytes32 }, [0]);

/** A sync entity. */
export const SyncEntityCodec = Enum(
    {
        Devices: Vector(
            Struct({
                statementAccountId: Bytes32,
                encryptionPublicKey: Bytes32,
                status: u8,
                lastUpdate: u64,
            }),
        ),
        ChatsAdded: Vector(ChatIdCodec),
        ChatsRemoved: Vector(ChatIdCodec),
        Messages: Vector(LocalMessageCodec),
    },
    [0, 1, 2, 3],
);

/** A sync message. */
export const SyncMessageCodec = Enum(
    {
        Update: Struct({ id: u32, entities: Vector(SyncEntityCodec), timePoint: u64 }),
        Ack: Struct({ id: u32 }),
    },
    [0, 1],
);
