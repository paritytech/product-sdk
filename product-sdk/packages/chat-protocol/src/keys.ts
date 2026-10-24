// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A chat identity a product holds itself. Experimental.
 *
 * The person chat gets its identity from the host's `PersonChat`, which the core
 * serves to the person chat product only, and peers find a person's chat key in
 * `DotnsGateway.AccountNames` on Asset Hub. Another product that talks this
 * protocol between its own users needs an identity of its own:
 * {@link selfCustodiedChatKeys} derives its chat and device keys from entropy only
 * this product and user can derive (the host's `entropy.derive`, RFC-0007) with
 * the RFC-0022 domains, and proves statements with an account the product holds.
 * Its peers must learn its chat key from the product itself (its own directory),
 * since the chain names only the person chat's keys; such an identity cannot
 * reach native person chat users.
 *
 * Which account a host lets a product prove statements with is not settled
 * (decision D12 of the plan), so this module stays experimental.
 *
 * @module
 */
import { concat } from "./bytes.js";
import { ecdhDomainSecret } from "./crypto/derivations.js";
import { sr25519PublicKey, sr25519Sign, x25519PublicKey } from "./crypto/primitives.js";
import type { ChatKeysPort, ChatProfile, ChatSecrets } from "./chat/ports.js";
import type { StatementProver } from "./ports.js";
import { VecU8 } from "./wire/scale.js";
import { type Statement, type StatementProof, statementProofPayload } from "./wire/statement.js";

/** A prover over an sr25519 secret key the product holds: its public key is the statement account. */
export function keypairProver(
    secretKey: Uint8Array,
): StatementProver & { sign(message: Uint8Array): Uint8Array } {
    const account = sr25519PublicKey(secretKey);
    return {
        account,
        async prove(statement: Statement): Promise<StatementProof> {
            return {
                tag: "Sr25519",
                value: {
                    signature: sr25519Sign(secretKey, statementProofPayload(statement)),
                    signer: account,
                },
            };
        },
        sign: (message) => sr25519Sign(secretKey, message),
    };
}

/** What {@link selfCustodiedChatKeys} builds an identity from. */
export interface SelfCustodiedIdentity {
    /** The account that names the user in this product's chat. */
    identityAccount: Uint8Array;
    /** Signs as the identity account (sr25519, `substrate` context), for the proofs of chat requests. */
    signAsIdentity(message: Uint8Array): Promise<Uint8Array>;
    /** Proves this device's statements; its account is the statement account. */
    prover: StatementProver;
    /** Entropy only this product and user derive. The chat and device keys come from it. */
    entropy: Uint8Array;
    /** The user's name in this product's chat, when it has one. */
    username?: string;
}

/**
 * A {@link ChatKeysPort} over an identity the product holds: chat key from
 * `ecdhDomainSecret(entropy, "chat")`, device key from the `"chat-device"` domain,
 * one device, statements proved by `identity.prover`.
 */
export function selfCustodiedChatKeys(identity: SelfCustodiedIdentity): ChatKeysPort {
    const chatIdentitySecret = ecdhDomainSecret(identity.entropy, "chat");
    const deviceEncSecret = ecdhDomainSecret(identity.entropy, "chat-device");
    const profile: ChatProfile = {
        identityAccountId: identity.identityAccount,
        chatPublicKey: x25519PublicKey(chatIdentitySecret),
        ...(identity.username !== undefined ? { liteUsername: identity.username } : {}),
        role: "Primary",
        statementAccountId: identity.prover.account,
        deviceEncPublicKey: x25519PublicKey(deviceEncSecret),
        ownDevices: [
            {
                statementAccountId: identity.prover.account,
                encryptionPublicKey: x25519PublicKey(deviceEncSecret),
                name: "this device",
            },
        ],
    };
    const secrets: ChatSecrets = { chatIdentitySecret, deviceEncSecret };
    return {
        profile: async () => profile,
        secrets: async () => secrets,
        statementProver: () => identity.prover,
        // What the inner proof of a chat request signs: the message, then the acceptor as SCALE bytes.
        proveChatRequest: (message, acceptor) =>
            identity.signAsIdentity(concat(message, VecU8.enc(acceptor))),
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { sr25519SecretFromSeed, sr25519Verify } = await import("./crypto/primitives.js");
    const { chatRequestProofPayload } = await import("./chat/requests.js");

    test("the keys are deterministic from the entropy, and a chat request proof verifies", async () => {
        const secret = sr25519SecretFromSeed(new Uint8Array(32).fill(5));
        const identity = keypairProver(secret);
        const keys = selfCustodiedChatKeys({
            identityAccount: identity.account,
            signAsIdentity: async (message) => identity.sign(message),
            prover: identity,
            entropy: new Uint8Array(16).fill(1),
        });
        const again = selfCustodiedChatKeys({
            identityAccount: identity.account,
            signAsIdentity: async (message) => identity.sign(message),
            prover: identity,
            entropy: new Uint8Array(16).fill(1),
        });
        expect((await keys.profile()).chatPublicKey).toEqual((await again.profile()).chatPublicKey);
        expect((await keys.secrets()).chatIdentitySecret).not.toEqual(
            (await keys.secrets()).deviceEncSecret,
        );

        const message = {
            messageId: "r1",
            timestamp: 1n,
            content: { tag: "V1" as const, value: { pushToken: undefined, welcome: undefined } },
        };
        const { ChatRequestMessageCodec } = await import("./wire/chatRequest.js");
        const acceptor = new Uint8Array(32).fill(9);
        const signature = await keys.proveChatRequest(
            ChatRequestMessageCodec.enc(message),
            acceptor,
        );
        expect(
            sr25519Verify(chatRequestProofPayload(message, acceptor), signature, identity.account),
        ).toBe(true);
    });

    test("a keypair prover's proof verifies over the statement's payload", async () => {
        const { verifiedSigner } = await import("./transport/statements.js");
        const prover = keypairProver(sr25519SecretFromSeed(new Uint8Array(32).fill(6)));
        const statement: Statement = { topics: [new Uint8Array(32)], data: new Uint8Array([1]) };
        const proof = await prover.prove(statement);
        expect(verifiedSigner({ ...statement, proof })).toEqual(prover.account);
    });
}
