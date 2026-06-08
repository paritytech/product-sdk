// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Public types for the host wrappers.
 *
 * The statement-store types are re-exported from `@parity/truapi` so the Parity
 * surface stays in lockstep with the in-house protocol codec types. Their fields
 * are `0x`-prefixed hex strings (`HexString`) and their enums are `{ tag }` unions.
 */

import type {
    ProductAccountId as TruProductAccountId,
    SignedStatement as TruSignedStatement,
    Statement as TruStatement,
    StatementProof as TruStatementProof,
    Topic as TruTopic,
} from "@parity/truapi";

/**
 * Persistent storage exposed by the host container, including string, JSON
 * and raw byte (`readBytes`/`writeBytes`) accessors. Most apps reach it
 * indirectly through the Storage package's `KvStore`; reach for it directly
 * via {@link getHostLocalStorage} when you need raw host storage without the
 * KV abstraction.
 *
 * Backed by `truApi.localStorage.*` (raw `read`/`write`/`clear` over hex bytes);
 * {@link getHostLocalStorage} adapts that into this richer surface. `readString`
 * resolves to `""` for a missing key and `readJSON`/`readBytes` to
 * `null`/`undefined`.
 */
export interface HostLocalStorage {
    /** Read a UTF-8 string value; `""` when the key is absent. */
    readString(key: string): Promise<string>;
    /** Write a UTF-8 string value. */
    writeString(key: string, value: string): Promise<void>;
    /** Read and JSON-parse a value; `null` when the key is absent. */
    readJSON(key: string): Promise<unknown>;
    /** JSON-stringify and write a value. */
    writeJSON(key: string, value: unknown): Promise<void>;
    /** Read raw bytes; `undefined` when the key is absent. */
    readBytes(key: string): Promise<Uint8Array | undefined>;
    /** Write raw bytes. */
    writeBytes(key: string, value: Uint8Array): Promise<void>;
    /** Remove a key. */
    clear(key: string): Promise<void>;
}

/**
 * Cryptographic proof attached to a statement before submission. Variants cover
 * the supported signature schemes — `Sr25519`, `Ed25519`, `Ecdsa`, and `OnChain`
 * (chain-attestation-based proofs). Re-exported from `@parity/truapi`; signature
 * and key fields are `0x`-prefixed hex strings.
 */
export type StatementProof = TruStatementProof;

/** A single 32-byte topic value (`0x`-prefixed hex) used inside a {@link StatementTopicFilter}. Re-exported from `@parity/truapi`. */
export type Topic = TruTopic;

/**
 * Identifies a product account by its dotNS domain identifier and key
 * derivation index. Re-exported from `@parity/truapi`.
 */
export type ProductAccountId = TruProductAccountId;

/** Unsigned statement payload (hex-string fields, `{ tag }` proof). Re-exported from `@parity/truapi`. */
export type Statement = TruStatement;

/** Statement bundled with its required {@link StatementProof}. Re-exported from `@parity/truapi`. */
export type SignedStatement = TruSignedStatement;

/**
 * Topic-based subscription filter. The host delivers statements that match
 * either *all* of the listed topics (`matchAll`) or *any* of them (`matchAny`).
 */
export type StatementTopicFilter = { matchAll: Topic[] } | { matchAny: Topic[] };

/**
 * A page of signed statements delivered by {@link HostStatementStore.subscribe}.
 *
 * Pages arrive sequentially. `isComplete` is `false` while the host streams the
 * historical backfill and `true` once it's done (and on every subsequent
 * live-update page). `statements` is `SignedStatement[]`.
 */
export interface StatementsPage {
    statements: SignedStatement[];
    isComplete: boolean;
}

/**
 * Subscription handle returned by the host. Exposes `unsubscribe()` plus an
 * `onInterrupt` hook that fires if the host interrupts the subscription
 * server-side; `onInterrupt` returns a function that cancels the hook.
 */
export interface HostSubscription {
    unsubscribe(): void;
    onInterrupt(callback: (reason?: unknown) => void): () => void;
}

/**
 * Statement Store handle exposed by the host container, backed by
 * `truApi.statementStore.*`. `subscribe` streams matching statements;
 * `createProofAuthorized` signs a statement with the product's RFC-10 allowance
 * account (the sponsored path — no per-call account id); `submit` publishes a
 * signed statement. The `statement-store` package layers a higher-level client
 * on top.
 */
export interface HostStatementStore {
    subscribe(
        filter: StatementTopicFilter,
        callback: (page: StatementsPage) => void,
    ): HostSubscription;
    createProofAuthorized(statement: Statement): Promise<StatementProof>;
    submit(signedStatement: SignedStatement): Promise<void>;
}
