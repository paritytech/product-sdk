// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Public types for the host wrappers.
 *
 * These are re-exported from `@novasamatech/host-api-wrapper` (the runtime
 * objects the host getters cast to) rather than hand-mirrored, so the
 * Parity surface stays in lockstep with the upstream codec types.
 */

import type {
    hostLocalStorage,
    createStatementStore,
    ProductAccountId as NovasamaProductAccountId,
    SignedStatement as NovasamaSignedStatement,
    Statement as NovasamaStatement,
    StatementTopicFilter as NovasamaStatementTopicFilter,
    StatementsPage as NovasamaStatementsPage,
    Topic as NovasamaTopic,
} from "@novasamatech/host-api-wrapper";
import type { Subscription } from "@novasamatech/host-api";

/**
 * Persistent storage exposed by the host container, including string, JSON
 * and raw byte (`readBytes`/`writeBytes`) accessors. Most apps reach it
 * indirectly through the Storage package's `KvStore`; reach for it directly
 * via {@link getHostLocalStorage} when you need raw host storage without the
 * KV abstraction.
 *
 * Type identical to `hostLocalStorage` from `@novasamatech/host-api-wrapper`.
 */
export type HostLocalStorage = typeof hostLocalStorage;

/**
 * Cryptographic proof attached to a statement before submission, returned by
 * {@link HostStatementStore.createProof}. Variants cover the supported
 * signature schemes - `Sr25519`, `Ed25519`, `Ecdsa`, and `OnChain` (chain-
 * attestation-based proofs).
 *
 * Inferred from `createStatementStore().createProof`'s return type so codec
 * changes surface here as compile errors, not runtime decode failures.
 */
export type StatementProof = Awaited<
    ReturnType<ReturnType<typeof createStatementStore>["createProof"]>
>;

/**
 * Topic-based subscription filter. The host delivers statements that match
 * either *all* of the listed topics (`matchAll`) or *any* of them
 * (`matchAny`). Re-exported from `@novasamatech/host-api-wrapper`.
 */
export type StatementTopicFilter = NovasamaStatementTopicFilter;

/** A single topic value used inside a {@link StatementTopicFilter}. Re-exported from `@novasamatech/host-api-wrapper`. */
export type Topic = NovasamaTopic;

/** `[ss58Address, chainPrefix]` tuple identifying a product account at the codec layer. Re-exported from `@novasamatech/host-api-wrapper`. */
export type ProductAccountId = NovasamaProductAccountId;

/** Unsigned statement payload. Re-exported from `@novasamatech/host-api-wrapper`. */
export type Statement = NovasamaStatement;

/** Statement bundled with its {@link StatementProof}. Re-exported from `@novasamatech/host-api-wrapper`. */
export type SignedStatement = NovasamaSignedStatement;

/**
 * A page of signed statements delivered by {@link HostStatementStore.subscribe}.
 *
 * Pages arrive sequentially. `isComplete` is `true` on the final page of a
 * subscription's initial backfill; subsequent pages contain new statements
 * as they appear on chain. `statements` is `SignedStatement[]` (typed,
 * not `unknown[]`).
 */
export type StatementsPage = NovasamaStatementsPage;

/**
 * Subscription handle returned by the host - equivalent to
 * `Subscription<void>` from `@novasamatech/host-api`. Exposes
 * `unsubscribe()` plus an `onInterrupt` hook that fires if the host
 * interrupts the subscription server-side.
 */
export type HostSubscription = Subscription<void>;

/**
 * Statement Store handle exposed by the host container. Provides
 * `subscribe`, `createProof`, and `submit` operations that go through the
 * host's native binary protocol; the `statement-store` package layers a
 * higher-level client on top.
 *
 * Type identical to `createStatementStore()` from
 * `@novasamatech/host-api-wrapper`.
 */
export type HostStatementStore = ReturnType<typeof createStatementStore>;
