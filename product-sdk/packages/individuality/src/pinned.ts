// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Block pinning: entries read a block apart can return a state the chain was never
 * in. Each public read pins its own, so two in sequence pin two — {@link pinBlock}
 * lets a composing read pin once and hand the snapshot down.
 */
import type { FinalizedSnapshot } from "./types.js";

/** Options every pinned storage read is given, so all of them agree on a block. */
export interface ReadAt {
    at: string;
    signal?: AbortSignal;
}

/**
 * The `getFinalizedBlock` escape hatch every read needs. `IndividualityChain` keeps
 * its own copy rather than extending this — it shipped first, and rewiring a
 * published interface buys no behaviour.
 */
export interface PinnedChain {
    raw: {
        individuality: {
            getFinalizedBlock(): Promise<{ hash: string; number: number }>;
        };
    };
}

/**
 * The abort check lives here because `getFinalizedBlock` takes no options and so
 * cannot carry a signal itself — without it an already-cancelled read would still
 * cost a round trip.
 */
export async function pinBlock(
    chain: PinnedChain,
    signal: AbortSignal | undefined,
    snapshot?: FinalizedSnapshot,
): Promise<FinalizedSnapshot> {
    signal?.throwIfAborted();
    if (snapshot !== undefined) {
        return snapshot;
    }
    const block = await chain.raw.individuality.getFinalizedBlock();
    return { blockHash: block.hash, blockNumber: block.number };
}

export function readAt(snapshot: FinalizedSnapshot, signal: AbortSignal | undefined): ReadAt {
    return { at: snapshot.blockHash, signal };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const BLOCK = { hash: `0x${"55".repeat(32)}`, number: 77 };
    const SNAPSHOT = { blockHash: `0x${"66".repeat(32)}`, blockNumber: 88 };

    function fakeChain() {
        let fetches = 0;
        const chain: PinnedChain = {
            raw: {
                individuality: {
                    getFinalizedBlock: async () => {
                        fetches += 1;
                        return BLOCK;
                    },
                },
            },
        };
        return { chain, fetches: () => fetches };
    }

    describe("pinBlock", () => {
        test("pins the finalized block when given no snapshot", async () => {
            const { chain, fetches } = fakeChain();
            expect(await pinBlock(chain, undefined)).toEqual({
                blockHash: BLOCK.hash,
                blockNumber: BLOCK.number,
            });
            expect(fetches()).toBe(1);
        });

        test("reuses a snapshot without a round trip", async () => {
            // The whole point: a composing read pins once, and the inner reads
            // must not each pin again.
            const { chain, fetches } = fakeChain();
            expect(await pinBlock(chain, undefined, SNAPSHOT)).toBe(SNAPSHOT);
            expect(fetches()).toBe(0);
        });

        test("an aborted signal throws before any round trip", async () => {
            const { chain, fetches } = fakeChain();
            const controller = new AbortController();
            controller.abort();
            await expect(pinBlock(chain, controller.signal)).rejects.toThrow();
            expect(fetches()).toBe(0);
        });

        test("an aborted signal throws even when a snapshot was supplied", async () => {
            const controller = new AbortController();
            controller.abort();
            await expect(
                pinBlock(fakeChain().chain, controller.signal, SNAPSHOT),
            ).rejects.toThrow();
        });
    });

    describe("readAt", () => {
        test("addresses the snapshot's hash and carries the signal", () => {
            const signal = new AbortController().signal;
            expect(readAt(SNAPSHOT, signal)).toEqual({ at: SNAPSHOT.blockHash, signal });
        });
    });
}
