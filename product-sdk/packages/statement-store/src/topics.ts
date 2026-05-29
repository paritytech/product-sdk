// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { blake2b256 } from "@parity/product-sdk-utils";

import type { ChannelHash, TopicFilter, TopicHash, SdkTopicFilter } from "./types.js";

/**
 * Create a 32-byte topic hash from a human-readable string.
 *
 * Uses blake2b-256 to hash the UTF-8 encoded string into a deterministic
 * 32-byte topic identifier. Statements are tagged with topics so subscribers
 * can filter efficiently on the network.
 *
 * @param name - A human-readable topic name (e.g., "ss-webrtc", "my-app").
 * @returns A branded 32-byte topic hash.
 *
 * @example
 * ```ts
 * const topic = createTopic("ss-webrtc");
 * // Use in subscriptions and publish options
 * ```
 */
export function createTopic(name: string): TopicHash {
    const bytes = new TextEncoder().encode(name);
    return blake2b256(bytes) as TopicHash;
}

/**
 * Create a 32-byte channel hash from a human-readable channel name.
 *
 * Channels enable last-write-wins semantics: for a given channel,
 * only the most recent statement (by timestamp) is retained.
 *
 * @param name - A human-readable channel name (e.g., "presence/peer-abc").
 * @returns A branded 32-byte channel hash.
 *
 * @example
 * ```ts
 * const channel = createChannel("presence/peer-abc123");
 * ```
 */
export function createChannel(name: string): ChannelHash {
    const bytes = new TextEncoder().encode(name);
    return blake2b256(bytes) as ChannelHash;
}

/**
 * Convert a topic or channel hash to a hex string (with 0x prefix).
 *
 * @param hash - A 32-byte topic or channel hash.
 * @returns Hex string with "0x" prefix.
 */
export function topicToHex(hash: Uint8Array): string {
    let hex = "0x";
    for (let i = 0; i < hash.length; i++) {
        hex += hash[i].toString(16).padStart(2, "0");
    }
    return hex;
}

/**
 * Compare two topic or channel hashes for byte equality.
 *
 * @param a - First hash.
 * @param b - Second hash.
 * @returns True if the hashes are identical.
 */
export function topicsEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Serialize a {@link TopicFilter} into the JSON-RPC format expected by statement store nodes.
 *
 * - `"any"` is passed through as the string `"any"`.
 * - `{ matchAll: [...] }` becomes `{ matchAll: ["0x...", ...] }` with hex-encoded topics.
 * - `{ matchAny: [...] }` becomes `{ matchAny: ["0x...", ...] }` with hex-encoded topics.
 *
 * @param filter - The topic filter to serialize.
 * @returns A JSON-RPC compatible filter value.
 */
export function serializeTopicFilter(filter: TopicFilter): SdkTopicFilter {
    if (filter === "any") return "any";

    if ("matchAll" in filter) {
        return { matchAll: filter.matchAll.map(topicToHex) };
    }

    return { matchAny: filter.matchAny.map(topicToHex) };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("createTopic", () => {
        test("produces a 32-byte hash", () => {
            const topic = createTopic("test");
            expect(topic).toBeInstanceOf(Uint8Array);
            expect(topic.length).toBe(32);
        });

        test("is deterministic (same input = same hash)", () => {
            const a = createTopic("ss-webrtc");
            const b = createTopic("ss-webrtc");
            expect(topicsEqual(a, b)).toBe(true);
        });

        test("different inputs produce different hashes", () => {
            const a = createTopic("topic-a");
            const b = createTopic("topic-b");
            expect(topicsEqual(a, b)).toBe(false);
        });

        test("empty string produces a valid hash", () => {
            const topic = createTopic("");
            expect(topic.length).toBe(32);
        });
    });

    describe("createChannel", () => {
        test("produces a 32-byte hash", () => {
            const channel = createChannel("presence/peer-abc");
            expect(channel).toBeInstanceOf(Uint8Array);
            expect(channel.length).toBe(32);
        });

        test("same input as createTopic produces same bytes", () => {
            const topic = createTopic("test-name");
            const channel = createChannel("test-name");
            expect(topicsEqual(topic, channel)).toBe(true);
        });
    });

    describe("topicToHex", () => {
        test("converts to hex with 0x prefix", () => {
            const hash = new Uint8Array(32);
            hash[0] = 0xab;
            hash[1] = 0xcd;
            const hex = topicToHex(hash);
            expect(hex).toMatch(/^0x/);
            expect(hex).toBe(`0xabcd${"00".repeat(30)}`);
        });

        test("round-trips through hex encoding", () => {
            const topic = createTopic("round-trip-test");
            const hex = topicToHex(topic);
            expect(hex.length).toBe(2 + 64); // "0x" + 64 hex chars
        });

        test("pads single-digit bytes with leading zero", () => {
            const hash = new Uint8Array([0x0a]);
            expect(topicToHex(hash)).toBe("0x0a");
        });
    });

    describe("topicsEqual", () => {
        test("returns true for identical hashes", () => {
            const a = createTopic("same");
            const b = createTopic("same");
            expect(topicsEqual(a, b)).toBe(true);
        });

        test("returns false for different hashes", () => {
            const a = createTopic("alpha");
            const b = createTopic("beta");
            expect(topicsEqual(a, b)).toBe(false);
        });

        test("returns false for different lengths", () => {
            const a = new Uint8Array(32);
            const b = new Uint8Array(16);
            expect(topicsEqual(a, b)).toBe(false);
        });

        test("returns true for empty arrays", () => {
            expect(topicsEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
        });
    });

    describe("serializeTopicFilter", () => {
        test("serializes 'any' as string", () => {
            expect(serializeTopicFilter("any")).toBe("any");
        });

        test("serializes matchAll with hex topics", () => {
            const topics = [createTopic("a"), createTopic("b")];
            const result = serializeTopicFilter({ matchAll: topics }) as {
                matchAll: string[];
            };
            expect(result.matchAll).toHaveLength(2);
            expect(result.matchAll[0]).toMatch(/^0x[0-9a-f]{64}$/);
            expect(result.matchAll[1]).toMatch(/^0x[0-9a-f]{64}$/);
        });

        test("serializes matchAny with hex topics", () => {
            const topics = [createTopic("x")];
            const result = serializeTopicFilter({ matchAny: topics }) as {
                matchAny: string[];
            };
            expect(result.matchAny).toHaveLength(1);
            expect(result.matchAny[0]).toMatch(/^0x[0-9a-f]{64}$/);
        });

        test("matchAll preserves order", () => {
            const topicA = createTopic("first");
            const topicB = createTopic("second");
            const result = serializeTopicFilter({ matchAll: [topicA, topicB] }) as {
                matchAll: string[];
            };
            expect(result.matchAll[0]).toBe(topicToHex(topicA));
            expect(result.matchAll[1]).toBe(topicToHex(topicB));
        });
    });
}
