/**
 * Persistent string and JSON storage exposed by the host container. Most
 * apps reach it indirectly through the Storage package's `LocalKvStore`; reach for
 * it directly via {@link getHostLocalStorage} when you need raw host storage
 * without the KV abstraction.
 */
export interface HostLocalStorage {
    readString(key: string): Promise<string | null>;
    writeString(key: string, value: string): Promise<void>;
    readJSON<T>(key: string): Promise<T | null>;
    writeJSON<T>(key: string, value: T): Promise<void>;
    /**
     * Clear a specific key from storage.
     * @param key - The key to clear
     */
    clear(key: string): Promise<void>;
}

/**
 * Cryptographic proof attached to a statement before submission, returned by
 * {@link HostStatementStore.createProof}. Variants cover the supported
 * signature schemes — `Sr25519`, `Ed25519`, `Ecdsa`, and `OnChain` (chain-
 * attestation-based proofs).
 *
 * Mirrors `@novasamatech/host-api-wrapper@0.7`'s proof shape.
 */
export type StatementProof =
    | { tag: "Sr25519"; value: { signature: Uint8Array; signer: Uint8Array } }
    | { tag: "Ed25519"; value: { signature: Uint8Array; signer: Uint8Array } }
    | { tag: "Ecdsa"; value: { signature: Uint8Array; signer: Uint8Array } }
    | {
          tag: "OnChain";
          value: { who: Uint8Array; blockHash: Uint8Array; event: bigint };
      };

/**
 * Topic-based subscription filter. Mirrors `StatementTopicFilter` from
 * `@novasamatech/host-api-wrapper` — the host delivers statements that match
 * either *all* of the listed topics (`matchAll`) or *any* of them
 * (`matchAny`).
 */
export type StatementTopicFilter = { matchAll: Uint8Array[] } | { matchAny: Uint8Array[] };

/**
 * A page of signed statements delivered by {@link HostStatementStore.subscribe}.
 *
 * Pages arrive sequentially. `isComplete` is `true` on the final page of a
 * subscription's initial backfill; subsequent pages contain new statements
 * as they appear on chain.
 */
export interface StatementsPage {
    statements: unknown[];
    isComplete: boolean;
}

/** Subscription handle returned by the host. */
export interface HostSubscription {
    unsubscribe: () => void;
}

/**
 * Statement Store handle exposed by the host container. Provides
 * `subscribe`, `createProof`, and `submit` operations that go through the
 * host's native binary protocol; the `statement-store` package layers a
 * higher-level client on top.
 *
 * Shape matches `@novasamatech/host-api-wrapper@0.7`'s `createStatementStore()`.
 */
export interface HostStatementStore {
    /**
     * Subscribe to statements matching the given topic filter.
     *
     * The callback is invoked once per page of statements. After the initial
     * backfill completes (signaled by `page.isComplete === true`), subsequent
     * pages contain new statements as they're produced.
     *
     * @param filter   - Topic match filter (`matchAll` or `matchAny`).
     * @param callback - Called with each `StatementsPage` from the host.
     * @returns Subscription handle with `unsubscribe`.
     */
    subscribe(
        filter: StatementTopicFilter,
        callback: (page: StatementsPage) => void,
    ): HostSubscription;

    /**
     * Create a proof for a statement using the given account.
     *
     * @param accountId - The account ID tuple `[ss58Address, chainPrefix]` from product-sdk.
     * @param statement - The unsigned statement.
     * @returns The proof (signature + signer info, or chain-attestation reference).
     */
    createProof(accountId: [string, number], statement: unknown): Promise<StatementProof>;

    /**
     * Submit a signed statement to the bulletin chain.
     * @param signedStatement - Statement with attached proof.
     */
    submit(signedStatement: unknown): Promise<void>;
}
