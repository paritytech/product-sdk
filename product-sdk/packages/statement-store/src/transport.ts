// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type {
    HostStatementStore,
    SignedStatement as HostSignedStatement,
    Statement as HostStatement,
    StatementTopicFilter,
} from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";

import { fromHex, toHex } from "./data.js";
import { StatementConnectionError, StatementSubscriptionError } from "./errors.js";
import type { Statement, TopicFilter as SdkTopicFilter } from "./statement.js";
import type { ConnectionCredentials, StatementTransport, Unsubscribable } from "./types.js";

const log = createLogger("statement-store:transport");

// ============================================================================
// Host Transport — uses the Host API's native binary protocol
// ============================================================================

/**
 * Statement transport that uses the Host API inside containers.
 *
 * Communicates through the host's native `remote_statement_store_*` protocol
 * (now via `@parity/truapi`), which bypasses JSON-RPC entirely. Submission uses
 * the RFC-10 sponsored path (`createProofAuthorized`): the host signs with the
 * product's allowance account, so no per-call account id is required.
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
                onStatements(page.statements.map(hostSignedStatementToSdk));
            });

            // Host-side teardown (transport close → `error`, host interrupt →
            // `complete`) is delivered only through `onInterrupt`; surface it so the
            // consumer learns the stream ended instead of silently waiting forever.
            sub.onInterrupt((reason) => {
                const msg =
                    reason instanceof Error
                        ? reason.message
                        : "Host ended the statement subscription";
                log.warn("Host subscription interrupted", { error: msg });
                onError(new StatementSubscriptionError(msg));
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
                "HostTransport requires host credentials. Use { mode: 'host' } to connect.",
            );
        }

        const hostStatement = sdkStatementToHost(statement);
        // RFC-10 sponsored path: the host signs with the product's allowance
        // account, so no per-call account id is needed.
        const proof = await this.store.createProofAuthorized(hostStatement);
        const signedStatement: HostSignedStatement = { ...hostStatement, proof };
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
// Host ↔ SDK Type Bridge
//
// Both sides now use `0x`-prefixed hex strings for topics/channel/decryptionKey
// and bigint expiry, so those fields pass through unchanged. Only two things
// differ: `data` (this package keeps raw `Uint8Array`; the host uses hex) and
// the proof discriminant (`{ type: "sr25519" }` here vs `{ tag: "Sr25519" }` on
// the host).
// ============================================================================

/** Convert an SDK TopicFilter → host StatementTopicFilter (both hex topics). */
function sdkFilterToHost(filter: SdkTopicFilter): StatementTopicFilter {
    if (filter === "any") {
        // The host API has no "match anything" variant — express it as
        // "match any of zero topics", which the host treats as a wildcard.
        return { matchAny: [] };
    }
    if ("matchAll" in filter) {
        return { matchAll: filter.matchAll };
    }
    return { matchAny: filter.matchAny };
}

/**
 * Convert a host SignedStatement → SDK Statement. The shapes are identical apart
 * from `data` (the wire type carries hex; this SDK layer decodes to bytes), so
 * everything else passes through unchanged.
 */
function hostSignedStatementToSdk(hostStmt: HostSignedStatement): Statement {
    return {
        ...hostStmt,
        data: hostStmt.data !== undefined ? fromHex(hostStmt.data) : undefined,
    };
}

/** Convert an SDK Statement (bytes `data`) → host Statement (hex `data`). */
function sdkStatementToHost(stmt: Statement): HostStatement {
    return {
        ...stmt,
        data: stmt.data !== undefined ? (toHex(stmt.data) as `0x${string}`) : undefined,
    };
}
