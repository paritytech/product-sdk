// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { Enum, Struct, u64, Vector } from "scale-ts";

import { concat } from "../bytes.js";
import { Bytes32, DecodeError, decodeStrict, Fixed, VecU8 } from "./scale.js";

/** Statement proof, as `sp_statement_store::Proof`. The chat signs and accepts only `Sr25519`. */
export const StatementProofCodec = Enum(
    {
        Sr25519: Struct({ signature: Fixed(64), signer: Bytes32 }),
        Ed25519: Struct({ signature: Fixed(64), signer: Bytes32 }),
        Secp256k1Ecdsa: Struct({ signature: Fixed(65), signer: Fixed(33) }),
        OnChain: Struct({ who: Bytes32, blockHash: Bytes32, event: u64 }),
    },
    [0, 1, 2, 3],
);

/** A statement proof. */
export type StatementProof = ReturnType<typeof StatementProofCodec.dec>;

const FieldCodec = Enum(
    {
        Proof: StatementProofCodec,
        DecryptionKey: Bytes32,
        Expiry: u64,
        Channel: Bytes32,
        Topic1: Bytes32,
        Topic2: Bytes32,
        Topic3: Bytes32,
        Topic4: Bytes32,
        Data: VecU8,
    },
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
);

type Field = ReturnType<typeof FieldCodec.dec>;

const FieldsCodec = Vector(FieldCodec);

const TOPIC_TAGS = ["Topic1", "Topic2", "Topic3", "Topic4"] as const;

/** Most topics a statement carries. */
export const MAX_TOPICS = 4;

/** A statement store statement (Appendix A.4). */
export interface Statement {
    proof?: StatementProof;
    decryptionKey?: Uint8Array;
    /** High 32 bits: expiry in unix seconds; low 32 bits: priority. */
    expiry?: bigint;
    channel?: Uint8Array;
    topics: Uint8Array[];
    data?: Uint8Array;
}

function unsignedFields(statement: Statement): Field[] {
    if (statement.topics.length > MAX_TOPICS) {
        throw new RangeError(`a statement carries at most ${MAX_TOPICS} topics`);
    }
    const fields: Field[] = [];
    if (statement.decryptionKey)
        fields.push({ tag: "DecryptionKey", value: statement.decryptionKey });
    if (statement.expiry !== undefined) fields.push({ tag: "Expiry", value: statement.expiry });
    if (statement.channel) fields.push({ tag: "Channel", value: statement.channel });
    statement.topics.forEach((topic, index) => {
        const tag = TOPIC_TAGS[index];
        if (tag) fields.push({ tag, value: topic });
    });
    if (statement.data) fields.push({ tag: "Data", value: statement.data });
    return fields;
}

/** SCALE encoding of `statement`: its fields sorted by tag, the proof first. */
export function encodeStatement(statement: Statement): Uint8Array {
    const fields = unsignedFields(statement);
    if (statement.proof) fields.unshift({ tag: "Proof", value: statement.proof });
    return FieldsCodec.enc(fields);
}

/**
 * The bytes an sr25519 statement proof signs: every non-proof field in tag
 * order, without the vector count (`KeypairSigningStatementStoreMessageProver`).
 */
export function statementProofPayload(statement: Statement): Uint8Array {
    return concat(...unsignedFields(statement).map((field) => FieldCodec.enc(field)));
}

/** Decodes a SCALE statement. Refuses duplicate or out-of-order fields and trailing bytes. */
export function decodeStatement(bytes: Uint8Array): Statement {
    const fields = decodeStrict(FieldsCodec, bytes);
    const statement: Statement = { topics: [] };
    let lastTag = -1;
    for (const field of fields) {
        const tagIndex = FIELD_ORDER.indexOf(field.tag);
        if (tagIndex <= lastTag) throw new DecodeError("statement fields out of order or repeated");
        lastTag = tagIndex;
        switch (field.tag) {
            case "Proof":
                statement.proof = field.value;
                break;
            case "DecryptionKey":
                statement.decryptionKey = field.value;
                break;
            case "Expiry":
                statement.expiry = field.value;
                break;
            case "Channel":
                statement.channel = field.value;
                break;
            case "Data":
                statement.data = field.value;
                break;
            default: {
                const topicIndex = TOPIC_TAGS.indexOf(field.tag);
                if (topicIndex !== statement.topics.length)
                    throw new DecodeError("statement topics not contiguous");
                statement.topics.push(field.value);
            }
        }
    }
    return statement;
}

const FIELD_ORDER: Field["tag"][] = [
    "Proof",
    "DecryptionKey",
    "Expiry",
    "Channel",
    "Topic1",
    "Topic2",
    "Topic3",
    "Topic4",
    "Data",
];

/** Encoded size of `statement` with a 96-byte sr25519 proof, whether or not it has one yet. */
export function signedStatementSize(statement: Statement): number {
    const placeholder: StatementProof = {
        tag: "Sr25519",
        value: { signature: new Uint8Array(64), signer: new Uint8Array(32) },
    };
    return encodeStatement({ ...statement, proof: placeholder }).length;
}
