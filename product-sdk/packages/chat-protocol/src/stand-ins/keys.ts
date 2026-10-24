// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    blake2b256,
    ecdhDomainSecret,
    type Statement,
    type StatementProof,
    type StatementProver,
    sr25519PublicKey,
    sr25519SecretFromSeed,
    sr25519Sign,
    statementProofPayload,
    utf8,
    x25519PublicKey,
} from "../index.js";

/** sr25519 prover over a local secret. Test double for the host's `PersonChat.proveStatement`. */
export class LocalProver implements StatementProver {
    readonly account: Uint8Array;

    constructor(private readonly secret: Uint8Array) {
        this.account = sr25519PublicKey(secret);
    }

    /** A prover for a deterministic seed derived from `label`. */
    static fromLabel(label: string): LocalProver {
        return new LocalProver(sr25519SecretFromSeed(blake2b256(utf8(`prover:${label}`))));
    }

    async prove(statement: Statement): Promise<StatementProof> {
        return {
            tag: "Sr25519",
            value: {
                signature: sr25519Sign(this.secret, statementProofPayload(statement)),
                signer: this.account,
            },
        };
    }

    /** Signs raw bytes, as the identity account signs chat-request proofs. */
    sign(message: Uint8Array): Uint8Array {
        return sr25519Sign(this.secret, message);
    }
}

/** Deterministic test identity: what the host's `PersonChat` profile and secrets would give a user. */
export interface TestIdentity {
    label: string;
    identity: LocalProver;
    chatSecret: Uint8Array;
    chatPublicKey: Uint8Array;
    deviceSecret: Uint8Array;
    devicePublicKey: Uint8Array;
}

/** A test identity derived from `label`, with the chat key derived as RFC-0022 does. */
export function testIdentity(label: string, device = "phone"): TestIdentity {
    const entropy = blake2b256(utf8(`entropy:${label}`)).subarray(0, 16);
    const chatSecret = ecdhDomainSecret(entropy, "chat");
    const deviceSecret = blake2b256(utf8(`device:${label}:${device}`));
    return {
        label,
        identity: LocalProver.fromLabel(label),
        chatSecret,
        chatPublicKey: x25519PublicKey(chatSecret),
        deviceSecret,
        devicePublicKey: x25519PublicKey(deviceSecret),
    };
}
