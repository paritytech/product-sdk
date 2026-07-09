// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test fakes for `@parity/product-sdk-statement-store`.
 *
 * `createFakeStatementTransport` is an in-memory `StatementTransport` for
 * `new StatementStoreClient({ transport })`. It records published statements and
 * echoes them to matching subscribers, so an app's publish/subscribe/dedup flow
 * runs against the real client with no host and no network.
 *
 * @packageDocumentation
 */
import type {
    ConnectionCredentials,
    SdkTopicFilter,
    Statement,
    StatementTransport,
    Unsubscribable,
} from "./types.js";

interface Subscription {
    filter: SdkTopicFilter;
    onStatements: (statements: Statement[]) => void;
}

/** Mirror of the host's topic-filter semantics against a statement's topics. */
function matchesFilter(filter: SdkTopicFilter, topics: ReadonlyArray<`0x${string}`>): boolean {
    if (filter === "any") return true;
    if ("matchAll" in filter) return filter.matchAll.every((t) => topics.includes(t));
    return filter.matchAny.some((t) => topics.includes(t));
}

/** An in-memory {@link StatementTransport} with an inspection surface for tests. */
export interface FakeStatementTransport extends StatementTransport {
    /** Statements passed to `signAndSubmit`, in order. */
    readonly published: ReadonlyArray<Statement>;
    /** `query` is always present on the fake (optional on the real interface). */
    query(filter: SdkTopicFilter): Promise<Statement[]>;
    /** Deliver an inbound statement to matching subscribers, as if a peer published it. */
    inject(statement: Statement): void;
    /** Clear published statements and drop all subscriptions. */
    reset(): void;
}

/**
 * Create an in-memory {@link StatementTransport}. `signAndSubmit` records the
 * statement and synchronously echoes it to every matching subscriber, so the
 * real client's dedup, TTL, and topic filtering run over a fake wire.
 *
 * @example
 * ```ts
 * import { StatementStoreClient } from "@parity/product-sdk-statement-store";
 * import { createFakeStatementTransport } from "@parity/product-sdk-statement-store/testing";
 *
 * const transport = createFakeStatementTransport();
 * const client = new StatementStoreClient({ appName: "my-app", transport });
 * await client.connect({ mode: "host" });
 * client.subscribe((s) => console.log(s.data));
 * await client.publish({ msg: "gm" });
 * ```
 */
export function createFakeStatementTransport(): FakeStatementTransport {
    const subscriptions = new Set<Subscription>();
    const published: Statement[] = [];

    const deliver = (statement: Statement) => {
        for (const sub of subscriptions) {
            if (matchesFilter(sub.filter, statement.topics)) sub.onStatements([statement]);
        }
    };

    return {
        published,
        subscribe(filter, onStatements, _onError): Unsubscribable {
            const sub: Subscription = { filter, onStatements };
            subscriptions.add(sub);
            return {
                unsubscribe: () => {
                    subscriptions.delete(sub);
                },
            };
        },
        async signAndSubmit(statement: Statement, _credentials: ConnectionCredentials) {
            published.push(statement);
            deliver(statement);
        },
        async query(filter) {
            return published.filter((s) => matchesFilter(filter, s.topics));
        },
        destroy() {
            subscriptions.clear();
        },
        inject(statement) {
            deliver(statement);
        },
        reset() {
            subscriptions.clear();
            published.length = 0;
        },
    } satisfies FakeStatementTransport;
}

if (import.meta.vitest) {
    // Round-trip guard: drive the fake through the *real* `StatementStoreClient`.
    const { describe, test, expect } = import.meta.vitest;
    const { StatementStoreClient } = await import("./client.js");

    describe("createFakeStatementTransport", () => {
        test("round-trips a published statement to a subscriber through the real client", async () => {
            const transport = createFakeStatementTransport();
            const client = new StatementStoreClient({ appName: "test-app", transport });
            await client.connect({ mode: "host" });

            const received: Array<{ msg: string }> = [];
            client.subscribe<{ msg: string }>((s) => received.push(s.data));
            const ok = await client.publish({ msg: "gm" });

            expect(ok).toBe(true);
            expect(transport.published).toHaveLength(1);
            expect(received).toEqual([{ msg: "gm" }]);

            client.destroy();
        });

        test("query returns published statements", async () => {
            const transport = createFakeStatementTransport();
            const client = new StatementStoreClient({ appName: "q-app", transport });
            await client.connect({ mode: "host" });
            await client.publish({ n: 1 });

            expect(await transport.query("any")).toHaveLength(1);
            client.destroy();
        });

        test("inject delivers a peer statement; reset clears state", () => {
            const transport = createFakeStatementTransport();
            const seen: Statement[] = [];
            transport.subscribe(
                "any",
                (batch) => seen.push(...batch),
                () => {},
            );

            const statement: Statement = {
                topics: [`0x${"11".repeat(32)}`],
                data: new Uint8Array([1, 2, 3]),
            };
            transport.inject(statement);
            expect(seen).toEqual([statement]);

            transport.reset();
            expect(transport.published).toHaveLength(0);
        });

        test("subscribe respects the topic filter", () => {
            const transport = createFakeStatementTransport();
            const wanted = `0x${"aa".repeat(32)}` as const;
            const other = `0x${"bb".repeat(32)}` as const;

            const seen: Statement[] = [];
            transport.subscribe(
                { matchAll: [wanted] },
                (batch) => seen.push(...batch),
                () => {},
            );

            transport.inject({ topics: [other], data: new Uint8Array([1]) });
            expect(seen).toHaveLength(0);
            transport.inject({ topics: [wanted], data: new Uint8Array([2]) });
            expect(seen).toHaveLength(1);
        });
    });
}
