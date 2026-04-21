// Re-export statement types from @novasamatech/sdk-statement
export type {
    Statement,
    SignedStatement,
    UnsignedStatement,
    Proof,
    SubmitResult,
    TopicFilter as SdkTopicFilter,
} from "@novasamatech/sdk-statement";

import type {
    Statement,
    SignedStatement,
    TopicFilter as SdkTopicFilter,
} from "@novasamatech/sdk-statement";

// ============================================================================
// Constants
// ============================================================================

/** Maximum size of a single statement's data payload in bytes. */
export const MAX_STATEMENT_SIZE = 512;

/** Maximum total storage per user in bytes. */
export const MAX_USER_TOTAL = 1024;

/** Default time-to-live for published statements in seconds. */
export const DEFAULT_TTL_SECONDS = 30;

// ============================================================================
// Branded Types
// ============================================================================

/**
 * A 32-byte blake2b-256 hash used as a statement topic.
 *
 * Topics allow subscribers to filter statements efficiently on the network.
 * Create one with {@link createTopic}.
 */
export type TopicHash = Uint8Array & { readonly __brand: "TopicHash" };

/**
 * A 32-byte blake2b-256 hash used as a statement channel identifier.
 *
 * Channels enable last-write-wins semantics: for a given channel,
 * only the most recent statement (by timestamp) is kept.
 * Create one with {@link createChannel}.
 */
export type ChannelHash = Uint8Array & { readonly __brand: "ChannelHash" };

// ============================================================================
// Topic Filtering
// ============================================================================

/**
 * Filter for statement subscriptions and queries.
 *
 * - `"any"` — matches all statements (no filtering).
 * - `{ matchAll: [...] }` — matches statements that have **all** listed topics.
 * - `{ matchAny: [...] }` — matches statements that have **any** listed topic.
 */
export type TopicFilter = "any" | { matchAll: TopicHash[] } | { matchAny: TopicHash[] };

// ============================================================================
// Signer & Credentials
// ============================================================================

/**
 * A function that signs a message with an Sr25519 key.
 *
 * Takes the signature material bytes and returns a 64-byte Sr25519 signature.
 * May be synchronous or asynchronous (e.g., when signing via a hardware wallet).
 */
export type StatementSigner = (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * An Sr25519 signer with its associated public key.
 *
 * Used by {@link StatementStoreClient.connect} to sign published statements
 * when running outside a container (local mode).
 */
export interface StatementSignerWithKey {
    /** 32-byte Sr25519 public key. */
    publicKey: Uint8Array;
    /** Signing function. */
    sign: StatementSigner;
}

/**
 * Credentials for connecting to the statement store.
 *
 * - **Host mode**: Inside a container, proof creation is delegated to the host API.
 *   The `accountId` is a `[ss58Address, chainPrefix]` tuple from product-sdk.
 * - **Local mode**: Outside a container, statements are signed locally using the
 *   provided Sr25519 signer.
 */
export type ConnectionCredentials =
    | { mode: "host"; accountId: [string, number] }
    | { mode: "local"; signer: StatementSignerWithKey };

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for {@link StatementStoreClient}.
 *
 * The client uses the Host API's native statement store protocol.
 * The SDK is designed to run exclusively inside a host container.
 */
export interface StatementStoreConfig {
    /**
     * Application namespace used as the primary topic (topic1).
     *
     * All statements published by this client are tagged with `blake2b(appName)`.
     * Subscribers filter on this topic to receive only relevant statements.
     *
     * @example "ss-webrtc", "mark3t-presence", "my-app"
     */
    appName: string;

    /**
     * Default time-to-live for published statements in seconds.
     *
     * Statements automatically expire after this duration.
     * Can be overridden per-publish via {@link PublishOptions.ttlSeconds}.
     *
     * @default 30
     */
    defaultTtlSeconds?: number;

    /**
     * Provide a custom transport instead of auto-detection.
     *
     * When set, the client uses this transport directly.
     * Useful for testing or advanced BYOD setups.
     */
    transport?: StatementTransport;
}

// ============================================================================
// Publish & Subscribe
// ============================================================================

/**
 * Options for publishing a single statement.
 */
export interface PublishOptions {
    /**
     * Channel name for last-write-wins semantics.
     *
     * When provided, the statement is tagged with `blake2b(channel)`.
     * For a given channel, only the most recent statement is kept.
     *
     * @example "presence/peer-abc123", "handshake/alice-bob"
     */
    channel?: string;

    /**
     * Secondary topic for additional filtering.
     *
     * Hashed with blake2b and set as topic2. Useful for scoping
     * statements to a specific room, document, or context.
     *
     * @example "doc-abc123", "room-456"
     */
    topic2?: string;

    /**
     * Time-to-live in seconds. Overrides {@link StatementStoreConfig.defaultTtlSeconds}.
     */
    ttlSeconds?: number;

    /**
     * Decryption key hint (32 bytes).
     *
     * Used by the `statement_posted` RPC method to filter statements.
     * Typically set to the blake2b hash of the room or document ID.
     */
    decryptionKey?: Uint8Array;
}

/**
 * A received statement with typed data and metadata.
 *
 * @typeParam T - The parsed data type (decoded from JSON).
 */
export interface ReceivedStatement<T = unknown> {
    /** Parsed data payload. */
    data: T;
    /** Signer's public key hex (from proof), if present. */
    signerHex?: string;
    /** Channel hex, if present. */
    channelHex?: string;
    /** Topics array (hex strings). */
    topics: string[];
    /** Combined expiry value (upper 32 bits = timestamp, lower 32 bits = sequence). */
    expiry?: bigint;
    /** The full statement from the transport for advanced inspection. */
    raw: Statement;
}

// ============================================================================
// Transport
// ============================================================================

/** Handle returned by subscription methods. Call `unsubscribe()` to stop receiving events. */
export interface Unsubscribable {
    unsubscribe: () => void;
}

/**
 * Low-level transport interface for statement store communication.
 *
 * Uses **HostTransport** — the Host API's native binary protocol.
 *
 * Most consumers should use {@link StatementStoreClient} instead of this interface directly.
 */
export interface StatementTransport {
    /**
     * Subscribe to statements matching a topic filter.
     *
     * @param filter - sdk-statement topic filter.
     * @param onStatements - Called with batches of received statements.
     * @param onError - Called when the subscription encounters an error.
     * @returns A handle to unsubscribe.
     */
    subscribe(
        filter: SdkTopicFilter,
        onStatements: (statements: Statement[]) => void,
        onError: (error: Error) => void,
    ): Unsubscribable;

    /**
     * Sign and submit a statement.
     *
     * - **Host mode**: delegates to the host API's `createProof` then `submit`.
     * - **Local mode**: signs locally using `getStatementSigner` from sdk-statement, then submits.
     *
     * @param statement - The unsigned statement to sign and submit.
     * @param credentials - Signing credentials (host accountId or local signer).
     */
    signAndSubmit(statement: Statement, credentials: ConnectionCredentials): Promise<void>;

    /**
     * Query existing statements from the store.
     *
     * Note: The host API subscription replays initial state, so this may not be needed.
     */
    query?(filter: SdkTopicFilter): Promise<Statement[]>;

    /** Destroy the transport and release all resources. */
    destroy(): void;
}
