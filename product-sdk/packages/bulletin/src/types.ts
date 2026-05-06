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

/** Options for gateway fetch operations. */
export interface FetchOptions {
    /** Timeout in ms. Default: 30_000. */
    timeoutMs?: number;
}

/**
 * Options for {@link BulletinClient.fetchBytes} / {@link BulletinClient.fetchJson}.
 *
 * Currently identical to {@link FetchOptions} — kept as a distinct named type
 * because the read path may grow query-specific options later (e.g., gateway
 * preference, retry budget) without breaking the public surface.
 */
export type QueryOptions = FetchOptions;
