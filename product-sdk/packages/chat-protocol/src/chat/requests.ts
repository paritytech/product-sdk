// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { bytesEqual } from "../bytes.js";
import {
    chatRequestDayTopic,
    chatRequestFullTopic,
    chatRequestSessionTopic,
    identityProof,
    protocolDay,
    statementExpiry,
    statementPriority,
} from "../crypto/derivations.js";
import {
    aeadKey,
    open,
    seal,
    sr25519Verify,
    x25519Agree,
    x25519Keypair,
} from "../crypto/primitives.js";
import {
    ChatRequestDecryptedCodec,
    type ChatRequestMessage,
    ChatRequestMessageCodec,
    EncryptedRemoteModelCodec,
    ProofPayloadCodec,
} from "../wire/chatRequest.js";
import { decodeLenient } from "../wire/scale.js";
import type { Statement } from "../wire/statement.js";

/** Largest notification-slot statement, and the allowance the native apps keep for its envelope. */
export const NOTIFICATION_STATEMENT_MAX_BYTES = 10 * 1024;
const NOTIFICATION_ENVELOPE_ALLOWANCE = 512;

/** Whether request statement data fits a notification-slot statement. */
export function requestFits(data: Uint8Array): boolean {
    return data.length + NOTIFICATION_ENVELOPE_ALLOWANCE <= NOTIFICATION_STATEMENT_MAX_BYTES;
}

/** Signs a chat request as the identity account (host `PersonChat.proveChatRequest`). */
export type ChatRequestSigner = (message: Uint8Array, acceptor: Uint8Array) => Promise<Uint8Array>;

/** Builds the statement data of a request: signed, then sealed to the acceptor's chat key with a fresh key. */
export async function sealChatRequest(params: {
    message: ChatRequestMessage;
    identityAccount: Uint8Array;
    acceptor: Uint8Array;
    acceptorChatKey: Uint8Array;
    sign: ChatRequestSigner;
}): Promise<Uint8Array> {
    const signature = await params.sign(
        ChatRequestMessageCodec.enc(params.message),
        params.acceptor,
    );
    const plaintext = ChatRequestDecryptedCodec.enc({
        message: params.message,
        proof: { tag: "Sr25519", value: { signature, signer: params.identityAccount } },
    });
    const ephemeral = x25519Keypair();
    const key = aeadKey(x25519Agree(ephemeral.privateKey, params.acceptorChatKey));
    return EncryptedRemoteModelCodec.enc({
        encryptionPubKey: ephemeral.publicKey,
        encryptedData: seal(key, plaintext),
    });
}

/** The bytes the inner proof signs. */
export function chatRequestProofPayload(
    message: ChatRequestMessage,
    acceptor: Uint8Array,
): Uint8Array {
    return ProofPayloadCodec.enc({ message, requestAcceptorId: acceptor });
}

/** The request statement (Android layout, D4): day, full and per-pair session topics, no channel. */
export function chatRequestStatement(params: {
    data: Uint8Array;
    acceptor: Uint8Array;
    requester: Uint8Array;
    chatSharedSecret: Uint8Array;
    nowMs: number;
}): Statement {
    return {
        expiry: statementExpiry(statementPriority(params.nowMs)),
        topics: [
            chatRequestDayTopic(params.acceptor, protocolDay(params.nowMs)),
            chatRequestFullTopic(params.acceptor),
            chatRequestSessionTopic(params.chatSharedSecret, params.requester, params.acceptor),
        ],
        data: params.data,
    };
}

/** An opened incoming request. */
export interface OpenedChatRequest {
    message: ChatRequestMessage;
    /** The inner proof's signer: the requester's statement account. */
    signer: Uint8Array;
    /** The requester's identity: V2 `identityAccountId`, or the signer for V1. */
    peerAccount: Uint8Array;
    deviceEncPubKey?: Uint8Array;
}

/** Opens a request addressed to us. Undefined when it does not decrypt, decode or verify. */
export function openChatRequest(
    statement: Statement,
    ownChatSecret: Uint8Array,
    ownAccount: Uint8Array,
): OpenedChatRequest | undefined {
    if (!statement.data) return undefined;
    try {
        const envelope = decodeLenient(EncryptedRemoteModelCodec, statement.data);
        const key = aeadKey(x25519Agree(ownChatSecret, envelope.encryptionPubKey));
        const decrypted = decodeLenient(
            ChatRequestDecryptedCodec,
            open(key, envelope.encryptedData),
        );
        const { signature, signer } = decrypted.proof.value;
        if (
            !sr25519Verify(
                chatRequestProofPayload(decrypted.message, ownAccount),
                signature,
                signer,
            )
        )
            return undefined;
        const content = decrypted.message.content;
        return content.tag === "V2"
            ? {
                  message: decrypted.message,
                  signer,
                  peerAccount: content.value.identityAccountId,
                  deviceEncPubKey: content.value.deviceEncPubKey,
              }
            : { message: decrypted.message, signer, peerAccount: signer };
    } catch {
        return undefined;
    }
}

/** Checks a V2 request's identity proof against the requester's on-chain chat key. V1 requests have none and pass. */
export function verifyIdentityProof(
    opened: OpenedChatRequest,
    ownChatSecret: Uint8Array,
    peerChatKey: Uint8Array,
): boolean {
    const content = opened.message.content;
    if (content.tag !== "V2") return true;
    const expected = identityProof(
        x25519Agree(ownChatSecret, peerChatKey),
        content.value.identityAccountId,
        opened.signer,
    );
    return bytesEqual(expected, content.value.proof);
}

/** The V2 identity proof we put in our own requests. */
export function ownIdentityProof(
    ownChatSecret: Uint8Array,
    acceptorChatKey: Uint8Array,
    identityAccount: Uint8Array,
    statementAccount: Uint8Array,
): Uint8Array {
    return identityProof(
        x25519Agree(ownChatSecret, acceptorChatKey),
        identityAccount,
        statementAccount,
    );
}
