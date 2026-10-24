// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { Statement, StatementProof } from "./wire/statement.js";

/** Topics a statement subscription matches. `matchAll` holds at most 4 topics, `matchAny` at most 128. */
export type StatementFilter = { matchAll: Uint8Array[] } | { matchAny: Uint8Array[] };

/** One page of statements. The stored backlog ends with `isComplete: true`; live statements follow. */
export interface StatementPage {
    statements: Statement[];
    isComplete: boolean;
}

/** Outcome of a statement submit, classified as the native apps classify node answers. */
export type SubmitOutcome =
    | { kind: "Accepted" }
    | { kind: "Rejected"; reason: string; retriable: boolean };

/** Handle that stops a subscription. */
export type Unsubscribe = () => void;

/** The host's statement store (TrUAPI `statementStore`). */
export interface StatementsPort {
    /** Submits a statement that already carries its proof. */
    submit(statement: Statement): Promise<SubmitOutcome>;
    /**
     * Subscribes to statements matching `filter`. `onEnd` runs when the stream ends for any reason;
     * the caller subscribes again.
     */
    subscribe(
        filter: StatementFilter,
        onPage: (page: StatementPage) => void,
        onEnd: (reason: string) => void,
    ): Unsubscribe;
}

/** Signs a statement as one account. */
export interface StatementProver {
    /** Account the proofs carry as signer. */
    readonly account: Uint8Array;
    prove(statement: Statement): Promise<StatementProof>;
}

export { type Clock, type IdSource, systemClock, uuidSource } from "@parity/product-sdk-utils";

/** Diagnostics sink. Never receives plaintext or keys. */
export interface Logger {
    debug(message: string): void;
    warn(message: string): void;
}

/** A logger that drops everything. */
export const silentLogger: Logger = { debug() {}, warn() {} };
