// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createLogger } from "@parity/product-sdk-logger";
import { type Result, err, normalizeError, ok } from "@parity/result";
import { blake2b256 } from "@parity/product-sdk-utils";

import { decodeData, encodeData, toHex } from "./data.js";
import { StatementConnectionError, StatementStoreError, StatementSubmitError } from "./errors.js";
import { createChannel, createTopic, serializeTopicFilter, topicToHex } from "./topics.js";
import { createTransport } from "./transport.js";
import type {
    ConnectionCredentials,
    PublishOptions,
    ReceivedStatement,
    StatementSignerWithKey,
    StatementStoreConfig,
    StatementTransport,
    Unsubscribable,
} from "./types.js";
import { DEFAULT_TTL_SECONDS } from "./types.js";

import { createExpiry } from "./statement.js";
import type { Statement } from "./statement.js";
import type { SdkTopicFilter } from "./types.js";

const log = createLogger("statement-store");

/**
 * High-level client for the Polkadot Statement Store.
 *
 * Provides a simple publish/subscribe API over the ephemeral statement store,
 * handling topic management and signing through the host API.
 *
 * The SDK is designed to run exclusively inside a host container.
 *
 * @example
 * ```ts
 * import { StatementStoreClient } from "@parity/product-sdk-statement-store";
 *
 * // Inside a container (host mode)
 * const client = new StatementStoreClient({ appName: "my-app" });
 * await client.connect({ mode: "host", accountId: ["5Grw...", 42] });
 *
 * // Publish
 * await client.publish({ type: "presence", peerId: "abc" }, {
 *     channel: "presence/abc",
 *     topic2: "room-123",
 * });
 *
 * // Subscribe
 * client.subscribe<{ type: string }>(statement => {
 *     console.log(statement.data.type);
 * });
 *
 * // Cleanup
 * client.destroy();
 * ```
 */
export class StatementStoreClient {
    private readonly config: Required<Pick<StatementStoreConfig, "appName" | "defaultTtlSeconds">> &
        Pick<StatementStoreConfig, "transport">;

    private transport: StatementTransport | null = null;
    private credentials: ConnectionCredentials | null = null;
    private subscription: Unsubscribable | null = null;
    private callbacks: Array<(statement: ReceivedStatement<unknown>) => void> = [];
    private connected = false;
    private connectPromise: Promise<void> | null = null;
    /** Set by destroy() so doConnect() can abort cleanly if destroy races with an in-flight connect. */
    private destroyed = false;

    /**
     * Track seen statements to avoid re-delivering the same statement.
     * Maps (signer, channel hex or data hash) to the expiry value: one slot per author, as the
     * store keeps them.
     */
    private seen = new Map<string, bigint>();

    /** Monotonic counter to ensure unique sequence numbers even within the same millisecond. */
    private sequenceCounter = 0;

    /** Cached hex topic string for the app name, used as the primary subscription topic. */
    private readonly appTopicHex: string;

    constructor(config: StatementStoreConfig) {
        this.config = {
            appName: config.appName,
            defaultTtlSeconds: config.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS,
            transport: config.transport,
        };
        this.appTopicHex = topicToHex(createTopic(config.appName));
    }

    /**
     * Connect to the statement store and start receiving statements.
     *
     * @param credentials - Connection credentials (host accountId or local signer).
     * @throws {StatementConnectionError} If the transport cannot be established.
     */
    async connect(credentials: ConnectionCredentials): Promise<void>;
    /** @deprecated Use `connect({ mode: "local", signer })` instead. */
    async connect(signer: StatementSignerWithKey): Promise<void>;
    async connect(arg: ConnectionCredentials | StatementSignerWithKey): Promise<void> {
        if (this.destroyed) {
            throw new StatementConnectionError(
                "Cannot connect: client has been destroyed. Create a new instance.",
            );
        }
        if (this.connected) {
            log.warn("Already connected, ignoring duplicate connect()");
            return;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }

        const credentials: ConnectionCredentials =
            "mode" in arg ? arg : { mode: "local", signer: arg };

        this.connectPromise = this.doConnect(credentials).finally(() => {
            this.connectPromise = null;
        });
        return this.connectPromise;
    }

    /* @integration */
    private async doConnect(credentials: ConnectionCredentials): Promise<void> {
        this.credentials = credentials;
        const transport = this.config.transport ?? (await createTransport());

        // destroy() may have been called while we were awaiting createTransport().
        // If so, clean up the newly-created transport (if we own it) instead of leaking.
        if (this.destroyed) {
            if (transport !== this.config.transport) {
                transport.destroy();
            }
            return;
        }

        this.transport = transport;

        try {
            log.info("Connected", { appName: this.config.appName });

            this.startSubscription();
            this.connected = true;
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    /**
     * Publish typed data to the statement store.
     *
     * @typeParam T - The type of data being published.
     * @param data - The value to publish (must be JSON-serializable, max 512 bytes).
     * @param options - Optional channel, topic2, TTL, and decryption key overrides.
     * @returns A {@link Result}: `ok(undefined)` if the statement was accepted, or `err`
     *   carrying a `StatementStoreError` — a `StatementConnectionError` (not connected), a
     *   `StatementDataTooLargeError` (encoded data exceeds 512 bytes), or a
     *   `StatementSubmitError` (the network rejected the submission).
     */
    async publish<T>(
        data: T,
        options?: PublishOptions,
    ): Promise<Result<void, StatementStoreError>> {
        if (!this.transport || !this.credentials) {
            return err(new StatementConnectionError("Not connected. Call connect() first."));
        }

        let dataBytes: Uint8Array;
        try {
            // encodeData throws StatementDataTooLargeError / StatementEncodingError;
            // normalizeError passes those through and wraps anything unexpected.
            dataBytes = encodeData(data);
        } catch (error) {
            return err(normalizeError(error, StatementStoreError));
        }

        const ttl = options?.ttlSeconds ?? this.config.defaultTtlSeconds;
        const expirationTimestamp = Math.floor(Date.now() / 1000) + ttl;
        const sequenceNumber = (Date.now() + this.sequenceCounter++) % 0xffffffff;
        const expiry = createExpiry(expirationTimestamp, sequenceNumber);

        const topics: `0x${string}`[] = [this.appTopicHex as `0x${string}`];
        if (options?.topic2) {
            topics.push(topicToHex(createTopic(options.topic2)) as `0x${string}`);
        }

        const statement: Statement = {
            expiry,
            topics,
            channel: options?.channel
                ? (topicToHex(createChannel(options.channel)) as `0x${string}`)
                : undefined,
            decryptionKey: options?.decryptionKey
                ? (topicToHex(options.decryptionKey) as `0x${string}`)
                : undefined,
            data: dataBytes,
        };

        try {
            await this.transport.signAndSubmit(statement, this.credentials);
            log.debug("Published", { channel: options?.channel });
            return ok(undefined);
        } catch (error) {
            log.error("Publish failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return err(new StatementSubmitError(error));
        }
    }

    /**
     * Subscribe to incoming statements on this application's topic.
     *
     * @typeParam T - The expected data type (decoded from JSON).
     * @param callback - Called for each new statement.
     * @param options - Optional secondary topic filter.
     * @returns A handle to unsubscribe.
     */
    subscribe<T>(
        callback: (statement: ReceivedStatement<T>) => void,
        options?: { topic2?: string },
    ): Unsubscribable {
        const topic2Hex = options?.topic2 ? topicToHex(createTopic(options.topic2)) : undefined;

        const wrappedCallback = (statement: ReceivedStatement<unknown>) => {
            if (topic2Hex) {
                if (!statement.topics[1] || statement.topics[1] !== topic2Hex) return;
            }
            callback(statement as ReceivedStatement<T>);
        };

        this.callbacks.push(wrappedCallback);

        return {
            unsubscribe: () => {
                const index = this.callbacks.indexOf(wrappedCallback);
                if (index >= 0) {
                    this.callbacks.splice(index, 1);
                }
            },
        };
    }

    /** Whether the client is connected and ready to publish/subscribe. */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Get the signer's public key as a hex string (with 0x prefix).
     *
     * @returns The hex-encoded public key, or empty string if not connected or in host mode.
     */
    getPublicKeyHex(): string {
        if (this.credentials?.mode === "local") {
            return topicToHex(this.credentials.signer.publicKey);
        }
        return "";
    }

    /**
     * Destroy the client, unsubscribing and closing the transport.
     *
     * Safe to call multiple times. After destruction, the client cannot be reused.
     */
    destroy(): void {
        // Signal to any in-flight doConnect() that cleanup should happen on its side.
        this.destroyed = true;

        if (this.subscription) {
            this.subscription.unsubscribe();
            this.subscription = null;
        }

        if (this.transport) {
            this.transport.destroy();
            this.transport = null;
        }

        this.credentials = null;
        this.connected = false;
        this.connectPromise = null;
        this.callbacks = [];
        this.seen.clear();

        log.info("Destroyed");
    }

    // ========================================================================
    // Internal
    // ========================================================================

    /* @integration */
    private startSubscription(): void {
        if (!this.transport) return;

        const filter = this.buildFilter();

        this.subscription = this.transport.subscribe(
            filter,
            (statements) => {
                for (const stmt of statements) {
                    this.handleStatementReceived(stmt);
                }
            },
            (error) => {
                log.warn("Subscription error", {
                    error: error.message,
                });
            },
        );
    }

    /** Remove entries from the seen map whose expiry timestamp is in the past. */
    private pruneSeenMap(): void {
        const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
        for (const [key, expiry] of this.seen) {
            const expiryTimestamp = expiry >> 32n;
            if (expiryTimestamp > 0n && expiryTimestamp < nowSeconds) {
                this.seen.delete(key);
            }
        }
    }

    /**
     * Process a received statement, dedup, parse, and deliver to callbacks.
     * Returns true if the statement was new and delivered.
     */
    private handleStatementReceived(stmt: Statement): boolean {
        this.pruneSeenMap();

        const parsed = this.parseStatement<unknown>(stmt);
        if (!parsed) {
            log.debug("Statement dropped: undecodable", { channel: stmt.channel });
            return false;
        }

        // Deduplication key: (signer, channel), or (signer, blake2b hash of data) without a
        // channel. The store's last-write-wins slot is per (account, channel), so two accounts
        // legitimately hold one statement each on the same channel; keying on the channel alone
        // collapsed every author into one slot and silently discarded all but the highest-expiry
        // statement on it.
        const channelKey =
            parsed.channelHex ?? (parsed.raw.data ? toHex(blake2b256(parsed.raw.data)) : "");
        const dedupeKey = `${parsed.signerHex ?? ""}|${channelKey}`;

        const existingExpiry = this.seen.get(dedupeKey);
        const newExpiry = parsed.expiry ?? 0n;

        if (existingExpiry !== undefined && newExpiry <= existingExpiry) {
            log.debug("Statement deduped", {
                channelHex: parsed.channelHex,
                signerHex: parsed.signerHex,
                existingExpiry,
                newExpiry,
            });
            return false;
        }

        this.seen.set(dedupeKey, newExpiry);

        for (const callback of [...this.callbacks]) {
            try {
                callback(parsed);
            } catch (error) {
                log.error("Callback error", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        return true;
    }

    private parseStatement<T>(stmt: Statement): ReceivedStatement<T> | null {
        try {
            if (!stmt.data) return null;

            const data = decodeData<T>(stmt.data);

            // Extract signer from proof if present
            let signerHex: string | undefined;
            if (stmt.proof) {
                const proofValue = stmt.proof.value as Record<string, unknown>;
                if ("signer" in proofValue && typeof proofValue.signer === "string") {
                    signerHex = proofValue.signer;
                }
            }

            return {
                data,
                signerHex,
                channelHex: stmt.channel,
                topics: stmt.topics ?? [],
                expiry: stmt.expiry,
                raw: stmt,
            };
        } catch {
            return null;
        }
    }

    /** Build an SdkTopicFilter for the app's primary topic. */
    private buildFilter(topic2Name?: string): SdkTopicFilter {
        const topics = [createTopic(this.config.appName)];
        if (topic2Name) topics.push(createTopic(topic2Name));
        return serializeTopicFilter({ matchAll: topics });
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { createFakeStatementTransport } = await import("./testing.js");

    const APP = "dedupe-app";
    // Expiries must be in the future: pruneSeenMap() evicts past-dated entries before the
    // dedupe check, so toy values would show every statement delivered whatever the key.
    const nowSecs = Math.floor(Date.now() / 1000);
    const later = createExpiry(nowSecs + 7 * 24 * 3600);
    const earlier = createExpiry(nowSecs + 7 * 24 * 3600 - 60);

    /** A statement as the wire carries it: one channel, an explicit signer, an explicit expiry. */
    const wire = (signer: `0x${string}`, expiry: bigint, who: string): Statement => ({
        topics: [topicToHex(createTopic(APP))],
        channel: topicToHex(createChannel("shared")),
        expiry,
        data: encodeData({ who }),
        proof: { tag: "Sr25519", value: { signature: "0x00", signer } },
    });

    async function deliveredFrom(...statements: Statement[]): Promise<string[]> {
        const transport = createFakeStatementTransport();
        const client = new StatementStoreClient({ appName: APP, transport });
        await client.connect({ mode: "host" });
        const seen: string[] = [];
        client.subscribe<{ who: string }>((s) => seen.push(s.data.who));
        for (const statement of statements) transport.inject(statement);
        client.destroy();
        return seen;
    }

    describe("StatementStoreClient dedupe", () => {
        test("keeps one slot per (signer, channel): two accounts on one channel are both delivered, whatever arrives first", async () => {
            // The store keeps one statement per (account, channel); the later-published account
            // holds the higher expiry, and the earlier account's statement arriving after it was
            // dropped when the key was the channel alone.
            const seen = await deliveredFrom(
                wire("0xaaaa", later, "alice"),
                wire("0xbbbb", earlier, "bob"),
            );
            expect(seen).toEqual(["alice", "bob"]);
        });

        test("still replaces within one account: an older statement on the same channel is not delivered", async () => {
            const seen = await deliveredFrom(
                wire("0xaaaa", later, "alice-new"),
                wire("0xaaaa", earlier, "alice-old"),
            );
            expect(seen).toEqual(["alice-new"]);
        });

        test("two accounts with the same expiry on one channel are both delivered", async () => {
            const seen = await deliveredFrom(
                wire("0xaaaa", later, "alice"),
                wire("0xbbbb", later, "bob"),
            );
            expect(seen).toEqual(["alice", "bob"]);
        });
    });
}
