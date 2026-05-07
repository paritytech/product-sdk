import type { BulletinTypedApi } from "@parity/bulletin-sdk";

/** Typed API for the Bulletin Chain (re-export from upstream). */
export type BulletinApi = BulletinTypedApi;

/** Re-exported environment string from chain-client. */
export type { Environment } from "@parity/product-sdk-chain-client";

/**
 * Authorization status for a Bulletin Chain account.
 *
 * Returned by {@link checkAuthorization} as a pre-flight check before storing
 * data. Consumers can use this to show "not authorized" or "insufficient quota"
 * messages instead of letting the transaction fail mid-execution.
 */
export interface AuthorizationStatus {
    /** Whether an authorization entry exists for this account. */
    authorized: boolean;
    /** Remaining transactions allowed. 0 if not authorized. */
    remainingTransactions: number;
    /** Remaining bytes allowed. 0n if not authorized. */
    remainingBytes: bigint;
    /** Block number when the authorization expires. 0 if not authorized. */
    expiration: number;
}

/**
 * Options for {@link BulletinClient.fetchBytes} / {@link BulletinClient.fetchJson}.
 */
export interface QueryOptions {
    /**
     * Timeout for the host preimage lookup subscription, in ms.
     * Default: 30_000. Applied per lookup — for chunked content (DAG-PB
     * manifest CIDs), the manifest fetch and each child chunk fetch
     * each get this budget.
     */
    lookupTimeoutMs?: number;
    /**
     * When `true`, return the raw bytes for the requested CID without
     * parsing or recursing into a DAG-PB manifest. Default: `false` — the
     * client transparently reassembles chunked content so callers don't
     * need to know whether a CID points at a single chunk or a manifest.
     *
     * Set this if you want to inspect the manifest itself, e.g., to read
     * `unixfs.fileSize()` ahead of fetching, or to drive your own chunk
     * pipeline.
     */
    noReassemble?: boolean;
}
