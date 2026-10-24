// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { Enum, Option, Struct, str, u8, u64 } from "scale-ts";

import { RichTextContentCodec } from "./chatMessage.js";
import { Bytes32, Fixed, VecU8 } from "./scale.js";

/** Push token as it travels in requests and `Token` messages. */
export const TokenContentCodec = Struct({ token: VecU8, platform: u8 });

/** Versioned request content (Appendix A.9.1). */
export const VersionedRequestContentCodec = Enum(
    {
        V1: Struct({ pushToken: Option(TokenContentCodec), welcome: Option(RichTextContentCodec) }),
        V2: Struct({
            identityAccountId: Bytes32,
            proof: Bytes32,
            deviceEncPubKey: Bytes32,
            pushToken: Option(TokenContentCodec),
            welcome: Option(RichTextContentCodec),
        }),
    },
    [0, 1],
);

/** Decoded request content. */
export type VersionedRequestContent = ReturnType<typeof VersionedRequestContentCodec.dec>;

/** The request message the requester signs. */
export const ChatRequestMessageCodec = Struct({
    messageId: str,
    timestamp: u64,
    content: VersionedRequestContentCodec,
});

/** A chat request message. */
export type ChatRequestMessage = ReturnType<typeof ChatRequestMessageCodec.dec>;

/** Inner proof: only sr25519. */
export const StatementProofRemoteCodec = Enum(
    { Sr25519: Struct({ signature: Fixed(64), signer: Bytes32 }) },
    [0],
);

/** Plaintext of an encrypted chat request. */
export const ChatRequestDecryptedCodec = Struct({
    message: ChatRequestMessageCodec,
    proof: StatementProofRemoteCodec,
});

/** Decoded request plaintext. */
export type ChatRequestDecrypted = ReturnType<typeof ChatRequestDecryptedCodec.dec>;

/** What the inner proof signs: the message and the acceptor's account. Never sent. */
export const ProofPayloadCodec = Struct({
    message: ChatRequestMessageCodec,
    requestAcceptorId: VecU8,
});

/** Statement data of a chat request: the ephemeral X25519 key and the sealed plaintext. */
export const EncryptedRemoteModelCodec = Struct({ encryptionPubKey: VecU8, encryptedData: VecU8 });
