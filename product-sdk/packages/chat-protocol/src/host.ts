// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The protocol's ports over the host.
 *
 * A product never opens a connection of its own: statements go through the
 * host's statement store, usernames and chat keys come from Asset Hub storage
 * through the host's chain calls, and sends run inside a host operation so the
 * worker is not stopped mid-send.
 *
 * @module
 */
import type {
    FinalizedStorageReader,
    HexString,
    OperationHold,
    SignedStatement,
    Statement as HostStatement,
    StatementProof as HostStatementProof,
    TruApi,
} from "@parity/product-sdk-host";

import { fromHex, toHex } from "./bytes.js";
import { accountNamesKey, decodeAccountNames } from "./chat/accountNames.js";
import type { AccountNamesEntry, DirectoryPort } from "./chat/ports.js";
import type { StatementsPort, SubmitOutcome } from "./ports.js";
import type { Statement, StatementProof } from "./wire/statement.js";

/** A submit the store may take later: the allowance ran out, or the store is full. */
const RETRIABLE_SUBMIT = /noAllowance|storeFull/i;

function hex(bytes: Uint8Array): HexString {
    return `0x${toHex(bytes)}`;
}

function proofToHost(proof: StatementProof): HostStatementProof {
    switch (proof.tag) {
        case "Sr25519":
        case "Ed25519":
            return {
                tag: proof.tag,
                value: { signature: hex(proof.value.signature), signer: hex(proof.value.signer) },
            };
        case "Secp256k1Ecdsa":
            return {
                tag: "Ecdsa",
                value: { signature: hex(proof.value.signature), signer: hex(proof.value.signer) },
            };
        case "OnChain":
            return {
                tag: "OnChain",
                value: {
                    who: hex(proof.value.who),
                    blockHash: hex(proof.value.blockHash),
                    event: proof.value.event,
                },
            };
    }
}

function proofFromHost(proof: HostStatementProof): StatementProof {
    switch (proof.tag) {
        case "Sr25519":
        case "Ed25519":
            return {
                tag: proof.tag,
                value: {
                    signature: fromHex(proof.value.signature),
                    signer: fromHex(proof.value.signer),
                },
            };
        case "Ecdsa":
            return {
                tag: "Secp256k1Ecdsa",
                value: {
                    signature: fromHex(proof.value.signature),
                    signer: fromHex(proof.value.signer),
                },
            };
        case "OnChain":
            return {
                tag: "OnChain",
                value: {
                    who: fromHex(proof.value.who),
                    blockHash: fromHex(proof.value.blockHash),
                    event: proof.value.event,
                },
            };
    }
}

/** A protocol statement as the host carries it. */
export function statementToHost(statement: Statement): HostStatement {
    return {
        ...(statement.proof ? { proof: proofToHost(statement.proof) } : {}),
        ...(statement.decryptionKey ? { decryptionKey: hex(statement.decryptionKey) } : {}),
        ...(statement.expiry !== undefined ? { expiry: statement.expiry } : {}),
        ...(statement.channel ? { channel: hex(statement.channel) } : {}),
        topics: statement.topics.map(hex),
        ...(statement.data ? { data: hex(statement.data) } : {}),
    };
}

/** A host statement as the protocol handles it. */
export function statementFromHost(statement: HostStatement | SignedStatement): Statement {
    return {
        ...(statement.proof ? { proof: proofFromHost(statement.proof) } : {}),
        ...(statement.decryptionKey ? { decryptionKey: fromHex(statement.decryptionKey) } : {}),
        ...(statement.expiry !== undefined ? { expiry: statement.expiry } : {}),
        ...(statement.channel ? { channel: fromHex(statement.channel) } : {}),
        topics: statement.topics.map(fromHex),
        ...(statement.data ? { data: fromHex(statement.data) } : {}),
    };
}

/** A readable reason of a host call error; a domain error keeps its whole value, so its variant can be matched. */
function reasonOf(error: unknown): string {
    if (error && typeof error === "object" && "tag" in error) {
        const tagged = error as { tag: string; value?: unknown };
        if (tagged.tag === "Domain")
            return JSON.stringify(tagged.value, (_key, value) =>
                typeof value === "bigint" ? value.toString() : value,
            );
        if (tagged.value && typeof tagged.value === "object" && "reason" in tagged.value)
            return `${tagged.tag}: ${String((tagged.value as { reason: unknown }).reason)}`;
        return tagged.tag;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * The host's statement store as a {@link StatementsPort}. A submit refused for the
 * allowance or a full store is retriable, as the native apps classify it.
 */
export function hostStatementsPort(client: TruApi): StatementsPort {
    return {
        async submit(statement): Promise<SubmitOutcome> {
            const host = statementToHost(statement);
            if (!host.proof)
                return { kind: "Rejected", reason: "statement without proof", retriable: false };
            const result = await client.statementStore.submit({ ...host, proof: host.proof });
            if (result.isOk()) return { kind: "Accepted" };
            const reason = reasonOf(result.error);
            return { kind: "Rejected", reason, retriable: RETRIABLE_SUBMIT.test(reason) };
        },
        subscribe(filter, onPage, onEnd) {
            const request =
                "matchAll" in filter
                    ? ({ tag: "MatchAll", value: filter.matchAll.map(hex) } as const)
                    : ({ tag: "MatchAny", value: filter.matchAny.map(hex) } as const);
            const subscription = client.statementStore.subscribe({ request }).subscribe({
                next: (page) =>
                    onPage({
                        statements: page.statements.map(statementFromHost),
                        isComplete: page.isComplete,
                    }),
                error: (error) => onEnd(reasonOf(error)),
                complete: () => onEnd("completed"),
            });
            return () => subscription.unsubscribe();
        },
    };
}

/** `statements` whose submits run inside `hold`, so the host keeps the worker running until in-flight sends finish. */
export function heldStatements(statements: StatementsPort, hold: OperationHold): StatementsPort {
    return {
        submit: (statement) => hold.around(() => statements.submit(statement)),
        subscribe: (filter, onPage, onEnd) => statements.subscribe(filter, onPage, onEnd),
    };
}

/** Usernames and chat keys from `DotnsGateway.AccountNames` on Asset Hub. */
export function hostDirectory(assetHub: FinalizedStorageReader): DirectoryPort {
    return {
        async accountNames(accountId: Uint8Array): Promise<AccountNamesEntry | undefined> {
            const value = await assetHub.read(accountNamesKey(accountId));
            return value ? decodeAccountNames(value) : undefined;
        },
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { errAsync, okAsync } = await import("neverthrow");

    const statement: Statement = {
        proof: {
            tag: "Sr25519",
            value: { signature: new Uint8Array(64).fill(1), signer: new Uint8Array(32).fill(2) },
        },
        expiry: 5n,
        channel: new Uint8Array(32).fill(3),
        topics: [new Uint8Array(32).fill(4)],
        data: new Uint8Array([5]),
    };

    test("statements convert to the host's shape and back", () => {
        expect(statementFromHost(statementToHost(statement))).toEqual(statement);
    });

    test("a submit refused for the allowance is retriable; any other refusal is not", async () => {
        const answers = [
            errAsync({
                tag: "Domain",
                value: { tag: "V1", value: { tag: "Rejected", value: { reason: "noAllowance" } } },
            }),
            errAsync({
                tag: "Domain",
                value: { tag: "V1", value: { tag: "Rejected", value: { reason: "badProof" } } },
            }),
            okAsync(undefined),
        ];
        const port = hostStatementsPort({
            statementStore: { submit: () => answers.shift() },
        } as unknown as TruApi);
        expect(await port.submit(statement)).toMatchObject({ kind: "Rejected", retriable: true });
        expect(await port.submit(statement)).toMatchObject({ kind: "Rejected", retriable: false });
        expect(await port.submit(statement)).toEqual({ kind: "Accepted" });
        expect(await port.submit({ topics: [] })).toMatchObject({
            kind: "Rejected",
            retriable: false,
        });
    });
}
