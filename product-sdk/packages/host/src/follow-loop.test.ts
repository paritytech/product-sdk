// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The real polkadot-api client over the real `createHostPapiProvider`, against
 * a fake host whose chain has a budget of follows, the way a node limits them
 * (`-32800`). Issue #543.
 *
 * Two things drive a phone into a refollow loop, and both are reproduced here:
 *
 * - A node that refuses every follow. The core ends each refused stream with a
 *   plain `Subscription interrupted`, not a connection reset, and the product
 *   never sees the `-32800` text.
 * - A polkadot-api client whose pinned-blocks state broke. Its `follow$` has no
 *   teardown, so every new reader opens another follow and the old one is
 *   never unfollowed (`@polkadot-api/observable-client` 0.19.4). Each leaked
 *   follower follows again on every stop it is sent.
 *
 * The fake host runs on fake timers and answers asynchronously, as truapi does.
 *
 * @module
 */

import { configure } from "@parity/product-sdk-logger";
import { blockHeader } from "@polkadot-api/substrate-bindings";
import { createClient } from "polkadot-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createHostPapiProvider, resetFollowersForTests } from "./papi-provider.js";
import type { TrUApiClient } from "@parity/truapi";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const toHex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const headerOf = (n: number) =>
    toHex(
        blockHeader.enc({
            parentHash: hash(Math.max(0, n - 1)),
            number: n,
            stateRoot: hash(9999),
            extrinsicRoot: hash(9998),
            digests: [],
        }),
    );

type Observer = { next: (i: unknown) => void; error: (e: unknown) => void; complete: () => void };
type HostFollow = { id: string; observer: Observer; live: boolean };

/** A host whose chain allows `budget` live follows and refuses the rest. */
function fakeHost(budget: number) {
    const chain = { head: 10 };
    const follows: HostFollow[] = [];
    const pendingCalls: Array<{ follow: string; fail: (error: unknown) => void }> = [];
    // How the core answers a call on a follow that has ended.
    const lostFollow = (follow: string) => ({
        tag: "HostFailure",
        value: {
            reason: `remote_chain_head_call: follow subscription "${follow}" ended when its connection closed`,
        },
    });
    const failCallsOn = (follow: string) => {
        for (let i = pendingCalls.length - 1; i >= 0; i--) {
            const call = pendingCalls[i]!;
            if (call.follow !== follow) continue;
            pendingCalls.splice(i, 1);
            later(() => call.fail(lostFollow(follow)));
        }
    };
    let operations = 0;
    const live = () => follows.filter((follow) => follow.live);
    const later = (fn: () => void) => setTimeout(fn, 0);
    const deliver = (follow: HostFollow, item: unknown) =>
        later(() => follow.live && follow.observer.next(item));
    const answer = (value: () => unknown) => ({
        match: (ok: (v: unknown) => unknown) =>
            new Promise((resolve) => later(() => resolve(ok(value())))),
    });

    const client = {
        chain: {
            followHeadSubscribe: () => ({
                subscribe: (observer: Observer) => {
                    const follow: HostFollow = {
                        id: `p:${follows.length + 1}`,
                        observer,
                        live: true,
                    };
                    follows.push(follow);
                    if (live().length > budget) {
                        // What a phone's product sees for a refused follow.
                        follow.live = false;
                        later(() => observer.error(new Error("Subscription interrupted")));
                    } else {
                        deliver(follow, {
                            tag: "Initialized",
                            value: { finalizedBlockHashes: [hash(chain.head)] },
                        });
                        deliver(follow, {
                            tag: "BestBlockChanged",
                            value: { bestBlockHash: hash(chain.head) },
                        });
                    }
                    return {
                        subscriptionId: follow.id,
                        unsubscribe: () => {
                            follow.live = false;
                        },
                    };
                },
                [Symbol.observable as symbol]() {
                    return this;
                },
            }),
            getHeadHeader: (request: { hash: string }) =>
                answer(() => ({ header: headerOf(Number.parseInt(request.hash.slice(2), 16)) })),
            getHeadStorage: (request: {
                followSubscriptionId: string;
                items: Array<{ key: string }>;
            }) =>
                answer(() => {
                    const operationId = `op${++operations}`;
                    const follow = follows.find((f) => f.id === request.followSubscriptionId);
                    if (follow) {
                        deliver(follow, {
                            tag: "OperationStorageItems",
                            value: {
                                operationId,
                                items: request.items.map((item) => ({
                                    key: item.key,
                                    hash: hash(4242),
                                })),
                            },
                        });
                        deliver(follow, { tag: "OperationStorageDone", value: { operationId } });
                    }
                    return { operation: { tag: "Started", value: { operationId } } };
                }),
            getHeadBody: () =>
                answer(() => ({
                    operation: { tag: "Started", value: { operationId: `op${++operations}` } },
                })),
            // Runtime calls stay pending until a test fails them, or their follow ends.
            callHead: (request: { followSubscriptionId: string }) => ({
                match: (_ok: unknown, err: (e: unknown) => unknown) =>
                    new Promise((resolve) => {
                        const follow = request.followSubscriptionId;
                        const fail = (e: unknown) => resolve(err(e));
                        if (!follows.find((f) => f.id === follow)?.live) {
                            later(() => fail(lostFollow(follow)));
                            return;
                        }
                        pendingCalls.push({ follow, fail });
                    }),
            }),
            unpinHead: () => answer(() => undefined),
            continueHead: () => answer(() => undefined),
            stopHeadOperation: () => answer(() => undefined),
        },
    } as unknown as TrUApiClient;

    return {
        client,
        chain,
        follows,
        live,
        /** Fail every runtime call in flight with an error that is not a lost follow. */
        failCalls(error: unknown) {
            for (const call of pendingCalls.splice(0)) call.fail(error);
        },
        /** A new finalized block on every live follow. */
        newBlock() {
            chain.head++;
            const head = chain.head;
            for (const follow of live()) {
                deliver(follow, {
                    tag: "NewBlock",
                    value: { blockHash: hash(head), parentBlockHash: hash(head - 1) },
                });
                deliver(follow, { tag: "BestBlockChanged", value: { bestBlockHash: hash(head) } });
                deliver(follow, {
                    tag: "Finalized",
                    value: { finalizedBlockHashes: [hash(head)], prunedBlockHashes: [] },
                });
            }
        },
        /** The core redials the chain socket: every live follow ends. */
        redial() {
            for (const follow of live()) {
                follow.live = false;
                setTimeout(() => failCallsOn(follow.id), 40);
                later(() => follow.observer.complete());
            }
        },
    };
}

/** A polkadot-api client over the provider, the way a product builds one. */
function product(host: ReturnType<typeof fakeHost>) {
    const client = createClient(createHostPapiProvider(host.client, "0xfeed"));
    return {
        client,
        /** A short read, the way an app reads state all the time. */
        query() {
            const subscription = client.finalizedBlock$.subscribe({
                next: () => queueMicrotask(() => subscription.unsubscribe()),
                error: () => {},
            });
        },
    };
}

/** Bring a client into the state where its pinned blocks are broken. */
async function breakClient(host: ReturnType<typeof fakeHost>, app: ReturnType<typeof product>) {
    app.query();
    await vi.advanceTimersByTimeAsync(200);
    // A long suspension: the refollow lands on blocks the client never saw, so it
    // fetches the runtime again, and every attempt times out.
    host.chain.head += 50;
    host.redial();
    await vi.advanceTimersByTimeAsync(6000);
    for (let attempt = 0; attempt < 4; attempt++) {
        host.failCalls(new Error("No answer within 30000ms."));
        await vi.advanceTimersByTimeAsync(1500);
    }
}

const lines: string[] = [];
beforeEach(() => {
    vi.useFakeTimers();
    lines.length = 0;
    configure({ level: "warn", handler: (entry) => lines.push(entry.message) });
    resetFollowersForTests();
});
afterEach(() => {
    vi.useRealTimers();
});

const followLines = () => lines.filter((line) => line.startsWith("chainHead follow"));

describe("a node that refuses every follow (#543)", () => {
    test("is asked again at a falling pace, not every 4 s", async () => {
        const host = fakeHost(0);
        const app = product(host);
        app.query();

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        // 250 ms doubling to 30 s: 8 follows in the first 62 s, then one every 30 s.
        // A 4 s cap asks 79 times.
        expect(host.follows.length).toBeLessThanOrEqual(16);
        app.client.destroy();
    });

    test("writes a bounded number of warn lines, not two per attempt", async () => {
        const host = fakeHost(0);
        const app = product(host);
        app.query();

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        // The first interrupt and restart, then one summary a minute. Two lines per
        // attempt is 157.
        expect(followLines().length).toBeLessThanOrEqual(6);
        app.client.destroy();
    });
});

describe("a polkadot-api client whose pinned blocks broke (#543)", () => {
    test("holds at most one host follow on its connection", async () => {
        const host = fakeHost(4);
        const app = product(host);
        await breakClient(host, app);

        for (let round = 0; round < 6; round++) {
            app.query();
            await vi.advanceTimersByTimeAsync(5000);
            expect(host.live().length).toBeLessThanOrEqual(1);
        }
        app.client.destroy();
    });

    test("does not open host follows as fast as it reads", async () => {
        const host = fakeHost(4);
        const app = product(host);
        await breakClient(host, app);
        const before = host.follows.length;

        // A read every 50 ms for 10 s: 200 readers.
        for (let tick = 0; tick < 200; tick++) {
            app.query();
            await vi.advanceTimersByTimeAsync(50);
        }

        // Paced like a refollow: 250 ms doubling to a 4 s cap, 5 in 10 s.
        expect(host.follows.length - before).toBeLessThanOrEqual(5);
        // And one warn line for them, though each new follow initializes.
        expect(followLines().filter((line) => line.includes("released"))).toHaveLength(1);
        app.client.destroy();
    });

    test("is not followed again by its leaked followers on a redial", async () => {
        const host = fakeHost(4);
        const app = product(host);
        await breakClient(host, app);
        for (let reader = 0; reader < 5; reader++) {
            app.query();
            await vi.advanceTimersByTimeAsync(5000);
        }
        const before = host.follows.length;

        host.redial();
        await vi.advanceTimersByTimeAsync(5000);

        // One follow ended, so one refollow, whatever the client leaked.
        expect(host.follows.length - before).toBeLessThanOrEqual(1);
        app.client.destroy();
    });
});
