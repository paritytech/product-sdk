// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createLogger } from "@parity/product-sdk-logger";

import type { StatementStoreClient } from "./client.js";
import { createChannel, topicToHex } from "./topics.js";
import type { PublishOptions, ReceivedStatement, Unsubscribable } from "./types.js";

const log = createLogger("statement-store:channels");

/**
 * Higher-level abstraction providing last-write-wins channel semantics
 * over the statement store.
 *
 * Each channel name maps to a single value. When a new value is written
 * to a channel, it replaces the previous one if its timestamp is newer.
 * This is ideal for presence announcements, signaling, and ephemeral state.
 *
 * @typeParam T - The type of values stored in channels.
 *   Values should include a `timestamp` field for ordering;
 *   if omitted, the current time is used automatically.
 *
 * @example
 * ```ts
 * interface Presence {
 *     type: "presence";
 *     peerId: string;
 *     timestamp: number;
 * }
 *
 * const channels = new ChannelStore<Presence>(client, { topic2: "doc-123" });
 *
 * // Write presence
 * await channels.write("presence/peer-abc", {
 *     type: "presence",
 *     peerId: "abc",
 *     timestamp: Date.now(),
 * });
 *
 * // Read all presences
 * for (const [name, value] of channels.readAll()) {
 *     console.log(`${name}: ${value.peerId}`);
 * }
 *
 * // React to changes
 * channels.onChange((name, value, previous) => {
 *     console.log(`Channel ${name} updated`);
 * });
 *
 * channels.destroy();
 * ```
 */
export class ChannelStore<T extends { timestamp?: number }> {
    private readonly client: StatementStoreClient;
    private readonly topic2: string | undefined;
    private readonly values = new Map<string, T>();
    /** Maps human-readable channel names to their hex hash keys, for consistent lookup. */
    private readonly nameToHash = new Map<string, string>();
    private readonly changeCallbacks: Array<
        (channelName: string, value: T, previous: T | undefined) => void
    > = [];
    private subscription: Unsubscribable | null = null;

    /**
     * @param client - The connected {@link StatementStoreClient} to use.
     * @param options - Optional secondary topic for scoping channels.
     */
    constructor(client: StatementStoreClient, options?: { topic2?: string }) {
        this.client = client;
        this.topic2 = options?.topic2;

        // Subscribe to incoming statements
        this.subscription = this.client.subscribe<T>(
            (statement) => this.handleStatement(statement),
            { topic2: this.topic2 },
        );
    }

    /**
     * Write a value to a named channel.
     *
     * If the value doesn't include a `timestamp`, one is added automatically
     * using `Date.now()`. The value is published to the statement store
     * with the channel name as the statement channel.
     *
     * @param channelName - The channel name (e.g., "presence/peer-abc").
     * @param value - The value to write.
     * @returns `true` if the statement was accepted by the network.
     */
    async write(channelName: string, value: T): Promise<boolean> {
        const timestamped = value.timestamp != null ? value : { ...value, timestamp: Date.now() };

        const options: PublishOptions = {
            channel: channelName,
            topic2: this.topic2,
        };

        const success = await this.client.publish(timestamped, options);

        if (success) {
            // Store by hash key so local writes and network echoes use the same key
            const hashKey = topicToHex(createChannel(channelName));
            this.nameToHash.set(channelName, hashKey);
            this.updateChannel(hashKey, timestamped);
        }

        return success;
    }

    /**
     * Read the latest value for a channel by its human-readable name.
     *
     * Looks up the channel hash from the name, then retrieves the value.
     * Also checks the hash directly for values received from the network
     * before any local write established the name mapping.
     *
     * @param channelName - The channel name (e.g., "presence/peer-abc").
     * @returns The latest value, or `undefined` if no value has been received.
     */
    read(channelName: string): T | undefined {
        const hashKey = this.nameToHash.get(channelName) ?? topicToHex(createChannel(channelName));
        return this.values.get(hashKey);
    }

    /**
     * Read all channel values as a read-only map.
     *
     * Keys are hex-encoded channel hashes. Use {@link read} for
     * lookup by human-readable name.
     *
     * @returns A map of channel hash to latest value.
     */
    readAll(): ReadonlyMap<string, T> {
        return this.values;
    }

    /**
     * Get the number of channels currently tracked.
     */
    get size(): number {
        return this.values.size;
    }

    /**
     * Subscribe to channel value changes.
     *
     * The callback is invoked whenever a channel value is updated
     * (either from the network or from a local write).
     *
     * @param callback - Called with the channel key (hex hash for network-received, hex hash for local writes), new value, and previous value.
     * @returns A handle to unsubscribe.
     */
    onChange(
        callback: (channelName: string, value: T, previous: T | undefined) => void,
    ): Unsubscribable {
        this.changeCallbacks.push(callback);
        return {
            unsubscribe: () => {
                const index = this.changeCallbacks.indexOf(callback);
                if (index >= 0) {
                    this.changeCallbacks.splice(index, 1);
                }
            },
        };
    }

    /**
     * Destroy the channel store and clean up subscriptions.
     *
     * Does not destroy the underlying client.
     */
    destroy(): void {
        if (this.subscription) {
            this.subscription.unsubscribe();
            this.subscription = null;
        }
        this.values.clear();
        this.nameToHash.clear();
        this.changeCallbacks.length = 0;
        log.debug("ChannelStore destroyed");
    }

    // ========================================================================
    // Internal
    // ========================================================================

    private handleStatement(statement: ReceivedStatement<T>): void {
        // We need a channel to determine the channel name.
        // Without a channel, we can't do last-write-wins deduplication.
        if (!statement.channelHex) return;

        // The channel hex is the blake2b of the channel name.
        // We store by the hex representation since we don't have
        // the original channel name from incoming statements.
        this.updateChannel(statement.channelHex, statement.data);
    }

    private updateChannel(channelName: string, value: T): void {
        const existing = this.values.get(channelName);

        // Last-write-wins: only update if newer
        if (existing) {
            const existingTs = existing.timestamp ?? 0;
            const newTs = value.timestamp ?? 0;
            if (newTs <= existingTs) {
                return; // Same or older value, skip (idempotent)
            }
        }

        const previous = existing;
        this.values.set(channelName, value);

        // Fire change callbacks (snapshot to handle mid-iteration unsubscribes)
        for (const callback of [...this.changeCallbacks]) {
            try {
                callback(channelName, value, previous);
            } catch (error) {
                log.error("onChange callback error", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
}

if (import.meta.vitest) {
    const { describe, test, expect, vi, beforeEach } = import.meta.vitest;
    const { configure } = await import("@parity/product-sdk-logger");

    beforeEach(() => {
        configure({ handler: () => {} });
    });

    // Minimal mock of StatementStoreClient
    function createMockClient() {
        const subscribeCallbacks: Array<(stmt: ReceivedStatement<unknown>) => void> = [];

        return {
            subscribe: vi.fn(
                <T>(
                    callback: (stmt: ReceivedStatement<T>) => void,
                    _options?: { topic2?: string },
                ) => {
                    subscribeCallbacks.push(callback as (stmt: ReceivedStatement<unknown>) => void);
                    return {
                        unsubscribe: () => {
                            const idx = subscribeCallbacks.indexOf(
                                callback as (stmt: ReceivedStatement<unknown>) => void,
                            );
                            if (idx >= 0) subscribeCallbacks.splice(idx, 1);
                        },
                    };
                },
            ),
            publish: vi.fn(async () => true),
            // Helper to simulate incoming statement
            _simulateStatement(stmt: ReceivedStatement<unknown>) {
                for (const cb of subscribeCallbacks) {
                    cb(stmt);
                }
            },
        };
    }

    type TestValue = { type: string; timestamp: number };

    describe("ChannelStore", () => {
        test("write publishes and updates local state", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );

            await store.write("presence/abc", { type: "presence", timestamp: 1000 });

            expect(mockClient.publish).toHaveBeenCalledOnce();
            // read by name resolves through the hash
            expect(store.read("presence/abc")).toEqual({ type: "presence", timestamp: 1000 });
        });

        test("write adds timestamp if missing", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<{ type: string; timestamp?: number }>(
                mockClient as unknown as StatementStoreClient,
            );

            const before = Date.now();
            await store.write("ch", { type: "test" });

            const calls = mockClient.publish.mock.calls as unknown[][];
            const published = calls[0][0] as { timestamp: number };
            expect(published.timestamp).toBeGreaterThanOrEqual(before);
        });

        test("write returns false on publish failure", async () => {
            const mockClient = createMockClient();
            mockClient.publish = vi.fn(async () => false);
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );

            const result = await store.write("ch", { type: "test", timestamp: 1 });
            expect(result).toBe(false);
            expect(store.read("ch")).toBeUndefined(); // Not stored on failure
        });

        test("read returns undefined for unknown channel", () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );

            expect(store.read("unknown")).toBeUndefined();
        });

        test("readAll returns all values keyed by hash", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );

            await store.write("a", { type: "a", timestamp: 1 });
            await store.write("b", { type: "b", timestamp: 2 });

            const all = store.readAll();
            expect(all.size).toBe(2);
        });

        test("size returns channel count", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );

            expect(store.size).toBe(0);
            await store.write("a", { type: "a", timestamp: 1 });
            expect(store.size).toBe(1);
            await store.write("b", { type: "b", timestamp: 2 });
            expect(store.size).toBe(2);
        });

        test("last-write-wins: newer timestamp replaces older", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );

            await store.write("ch", { type: "old", timestamp: 100 });
            await store.write("ch", { type: "new", timestamp: 200 });

            expect(store.read("ch")?.type).toBe("new");
        });

        test("last-write-wins: older timestamp is ignored", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );

            await store.write("ch", { type: "new", timestamp: 200 });
            await store.write("ch", { type: "old", timestamp: 100 });

            expect(store.read("ch")?.type).toBe("new");
        });

        test("onChange fires on update with previous value", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );
            const onChange = vi.fn();
            store.onChange(onChange);

            await store.write("ch", { type: "first", timestamp: 1 });
            expect(onChange).toHaveBeenCalledOnce();
            expect(onChange.mock.calls[0][1]).toEqual({ type: "first", timestamp: 1 });
            expect(onChange.mock.calls[0][2]).toBeUndefined();

            await store.write("ch", { type: "second", timestamp: 2 });
            expect(onChange).toHaveBeenCalledTimes(2);
            expect(onChange.mock.calls[1][1]).toEqual({ type: "second", timestamp: 2 });
            expect(onChange.mock.calls[1][2]).toEqual({ type: "first", timestamp: 1 });
        });

        test("onChange unsubscribe stops notifications", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );
            const onChange = vi.fn();
            const sub = store.onChange(onChange);

            await store.write("ch", { type: "first", timestamp: 1 });
            expect(onChange).toHaveBeenCalledOnce();

            sub.unsubscribe();

            await store.write("ch", { type: "second", timestamp: 2 });
            expect(onChange).toHaveBeenCalledOnce(); // No additional call
        });

        test("destroy cleans up", async () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );

            await store.write("ch", { type: "test", timestamp: 1 });
            store.destroy();

            expect(store.readAll().size).toBe(0);
        });

        test("destroy is safe when subscription is already null", () => {
            const mockClient = createMockClient();
            const store = new ChannelStore<TestValue>(
                mockClient as unknown as StatementStoreClient,
            );
            store.destroy();
            // Second destroy — subscription is already null
            expect(() => store.destroy()).not.toThrow();
        });
    });
}
