// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createLogger } from "@parity/product-sdk-logger";
import type { HostStatementStore, StatementTopicFilter } from "@parity/product-sdk-host";

import { StatementConnectionError, StatementSubscriptionError } from "./errors.js";
import type { ConnectionCredentials, StatementTransport, Unsubscribable } from "./types.js";

import type { Statement, TopicFilter as SdkTopicFilter } from "@novasamatech/sdk-statement";

// Type-only imports for the host↔sdk bridge (erased at compile time, zero bundle cost).
// product-sdk's SCALE-decoded types use Uint8Array + { tag } enums;
// sdk-statement's types use hex strings + { type } enums.
import type {
    Statement as HostStatement,
    SignedStatement as HostSignedStatement,
} from "@novasamatech/host-api-wrapper";

const log = createLogger("statement-store:transport");

// ============================================================================
// Host Transport — uses the Host API's native binary protocol
// ============================================================================

/**
 * Statement transport that uses the Host API inside containers.
 *
 * Communicates through the host's native `remote_statement_store_*` protocol
 * which bypasses JSON-RPC entirely. Subscriptions, proof creation, and submission
 * all go through typed binary messages over the host transport.
 */
class HostTransport implements StatementTransport {
    private readonly store: HostStatementStore;

    constructor(store: HostStatementStore) {
        this.store = store;
    }

    subscribe(
        filter: SdkTopicFilter,
        onStatements: (statements: Statement[]) => void,
        onError: (error: Error) => void,
    ): Unsubscribable {
        const hostFilter = sdkFilterToHost(filter);

        try {
            const sub = this.store.subscribe(hostFilter, (page) => {
                // product-sdk delivers HostSignedStatement[] (Uint8Array fields, { tag } enums)
                // inside a StatementsPage. sdk-statement expects Statement (hex string fields,
                // { type } enums). Type assertion needed: page.statements is unknown[] at the
                // interface boundary but actual runtime values are HostSignedStatement[].
                const converted = (page.statements as HostSignedStatement[]).map(
                    hostSignedStatementToSdk,
                );
                onStatements(converted);
            });

            log.info("Host subscription active");

            return {
                unsubscribe: () => sub.unsubscribe(),
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.warn("Host subscription failed", { error: msg });
            onError(new StatementSubscriptionError(msg));
            return { unsubscribe: () => {} };
        }
    }

    async signAndSubmit(statement: Statement, credentials: ConnectionCredentials): Promise<void> {
        if (credentials.mode !== "host") {
            throw new StatementConnectionError(
                "HostTransport requires host credentials. Use { mode: 'host', accountId } to connect.",
            );
        }

        // Convert sdk-statement format (hex strings) → product-sdk format (Uint8Array)
        // so the host's SCALE codec can encode it correctly.
        const hostStatement = sdkStatementToHost(statement);
        const proof = await this.store.createProof(credentials.accountId, hostStatement);
        // Type assertion: StatementProof from host types is compatible with HostSignedStatement.proof
        // at runtime, but TypeScript can't verify cross-package type compatibility.
        const signedStatement: HostSignedStatement = {
            ...hostStatement,
            proof: proof as HostSignedStatement["proof"],
        };
        await this.store.submit(signedStatement);

        log.debug("Statement submitted via host");
    }

    destroy(): void {
        // Host owns the transport — nothing to clean up
    }
}

// ============================================================================
// Transport Factory
// ============================================================================

/**
 * Create a statement store transport.
 *
 * Uses the Host API via `@parity/product-sdk-host` — the container's native
 * statement store protocol (binary, not JSON-RPC). This is the only supported path.
 *
 * @throws {StatementConnectionError} If the host statement store is unavailable.
 */
export async function createTransport(): Promise<StatementTransport> {
    const { getStatementStore } = await import("@parity/product-sdk-host");
    const store = await getStatementStore();

    if (!store) {
        throw new StatementConnectionError(
            "Host statement store unavailable. Ensure you are running inside a host container (Polkadot Browser / Desktop).",
        );
    }

    log.info("Using host API statement store transport");
    return new HostTransport(store);
}

// ============================================================================
// Internal Helpers
// ============================================================================

// ============================================================================
// Host ↔ SDK Type Bridge
//
// product-sdk types (SCALE-decoded): Uint8Array fields, { tag: "Sr25519" } enums
// sdk-statement types:               hex string fields, { type: "sr25519" } enums
//
// Both represent the same on-chain statement data but with different runtime
// shapes. These converters bridge between the two so HostTransport can speak
// both languages correctly.
// ============================================================================

/** Convert an sdk-statement TopicFilter (hex strings) → host StatementTopicFilter (Uint8Array). */
function sdkFilterToHost(filter: SdkTopicFilter): StatementTopicFilter {
    if (filter === "any") {
        // The host API has no "match anything" variant — express it as
        // "match any of zero topics" which the host treats as a wildcard.
        return { matchAny: [] };
    }
    if ("matchAll" in filter) {
        return { matchAll: filter.matchAll.map(hexToBytes) };
    }
    return { matchAny: filter.matchAny.map(hexToBytes) };
}

/** Convert a product-sdk SignedStatement (Uint8Array fields) → sdk-statement Statement (hex strings). */
function hostSignedStatementToSdk(hostStmt: HostSignedStatement): Statement {
    const result: Partial<Statement> = {};

    // data: Uint8Array → Uint8Array (same in both formats)
    if (hostStmt.data) result.data = hostStmt.data;

    // expiry: bigint → bigint (same in both formats)
    if (hostStmt.expiry !== undefined) result.expiry = hostStmt.expiry;

    // topics: Uint8Array[] → hex string[]
    if (hostStmt.topics) {
        result.topics = hostStmt.topics.map(bytesToHex) as Statement["topics"];
    }

    // channel: Uint8Array → hex string
    if (hostStmt.channel) {
        result.channel = bytesToHex(hostStmt.channel) as Statement["channel"];
    }

    // decryptionKey: Uint8Array → hex string
    if (hostStmt.decryptionKey) {
        result.decryptionKey = bytesToHex(hostStmt.decryptionKey) as Statement["decryptionKey"];
    }

    // proof: { tag: "Sr25519" | "Ed25519" | "Ecdsa" | "OnChain", value: ... }
    //      → { type: "sr25519" | "ed25519" | "ecdsa" | "onChain", value: ... } (with hex)
    if (hostStmt.proof) {
        const tag = hostStmt.proof.tag;
        const value = hostStmt.proof.value;
        // Product-sdk proof tags use PascalCase; sdk-statement variants are camelCase.
        const sdkType =
            tag === "OnChain" ? "onChain" : (tag.toLowerCase() as "sr25519" | "ed25519" | "ecdsa");

        if (sdkType === "onChain" && "who" in value) {
            result.proof = {
                type: "onChain",
                value: {
                    who: bytesToHex(value.who),
                    blockHash: bytesToHex(value.blockHash),
                    event: value.event,
                },
            } as Statement["proof"];
        } else if ("signature" in value && "signer" in value) {
            result.proof = {
                type: sdkType,
                value: {
                    signature: bytesToHex(value.signature),
                    signer: bytesToHex(value.signer),
                },
            } as Statement["proof"];
        }
    }

    return result as Statement;
}

/** Convert an sdk-statement Statement (hex strings) → product-sdk HostStatement (Uint8Array). */
function sdkStatementToHost(stmt: Statement): HostStatement {
    const result: Partial<HostStatement> = {};

    // data: Uint8Array → Uint8Array (same)
    if (stmt.data) result.data = stmt.data;

    // expiry: bigint → bigint (same)
    if (stmt.expiry !== undefined) result.expiry = stmt.expiry;

    // topics: hex string[] → Uint8Array[]
    if (stmt.topics) {
        result.topics = stmt.topics.map(hexToBytes);
    }

    // channel: hex string → Uint8Array
    if (stmt.channel) {
        result.channel = hexToBytes(stmt.channel);
    }

    // decryptionKey: hex string → Uint8Array
    if (stmt.decryptionKey) {
        result.decryptionKey = hexToBytes(stmt.decryptionKey);
    }

    return result as HostStatement;
}

/** Convert a 0x-prefixed hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** Convert Uint8Array to 0x-prefixed hex string. */
function bytesToHex(bytes: Uint8Array): string {
    let hex = "0x";
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
}
