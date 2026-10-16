// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Block pinning: entries read a block apart can return a state the chain was never
 * in. Each public read pins its own, so two in sequence pin two — {@link readPinned}
 * lets a composing read pin once and hand the snapshot down.
 */
import type { BlockSource } from "./chain.js";
import { ProductIndividualityError } from "./errors.js";
import type { BlockAt, FinalizedSnapshot } from "./types.js";

/** Options every pinned storage read is given, so all of them agree on a block. */
export interface ReadAt {
    at: string;
    signal?: AbortSignal;
}

/**
 * The raw client every pinned read resolves its block with. `IndividualityChain`
 * keeps its own copy rather than extending this — it shipped first, and rewiring
 * a published interface buys no behaviour.
 */
export interface PinnedChain {
    raw: {
        individuality: BlockSource;
    };
}

/** The most times one read runs. More restarts than that mean the connection is not holding. */
const MAX_ATTEMPTS = 3;

/** Run `read` at the block `at` names, pinned from `chain`. See {@link readRepinning}. */
export async function readPinned<T>(
    chain: PinnedChain,
    signal: AbortSignal | undefined,
    at: BlockAt | undefined,
    read: (snapshot: FinalizedSnapshot) => Promise<T>,
): Promise<T> {
    return readRepinning(() => pinBlock(chain, signal, at), read);
}

/**
 * Run `read` at the block `pin` returns. If PAPI drops that block mid-read, as a
 * follow restart does, pin again and run `read` at the new block.
 *
 * PAPI throws `BlockNotPinnedError` only once its new follow is ready, so the new pin
 * is a block that follow holds. Stops after {@link MAX_ATTEMPTS} runs, or when the new
 * pin is the dropped block, which is always the case for a caller's snapshot.
 */
export async function readRepinning<T>(
    pin: () => Promise<FinalizedSnapshot>,
    read: (snapshot: FinalizedSnapshot) => Promise<T>,
): Promise<T> {
    let snapshot = await pin();
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            return await read(snapshot);
        } catch (error) {
            lastError = error;

            if (!isBlockNotPinned(error)) {
                throw error;
            }

            if (attempt + 1 >= MAX_ATTEMPTS) {
                break;
            }

            const next = await pin();
            if (next.blockHash === snapshot.blockHash) {
                throw error;
            }
            snapshot = next;
        }
    }

    throw lastError;
}

/**
 * Matched by name rather than `instanceof`: a product can load a second copy of
 * PAPI, and `instanceof` fails across copies.
 */
function isBlockNotPinned(error: unknown): boolean {
    return error instanceof Error && error.name === "BlockNotPinnedError";
}

/**
 * The abort check lives here because the raw client takes no options and so
 * cannot carry a signal itself — without it an already-cancelled read would still
 * cost a round trip.
 */
async function pinBlock(
    chain: PinnedChain,
    signal: AbortSignal | undefined,
    at: BlockAt = "finalized",
): Promise<FinalizedSnapshot> {
    signal?.throwIfAborted();
    if (typeof at === "object") {
        return at;
    }
    const source = chain.raw.individuality;
    const block =
        at === "best" ? (await source.getBestBlocks())[0] : await source.getFinalizedBlock();
    if (block === undefined) {
        throw new ProductIndividualityError("the chain client reported no best block");
    }
    return { blockHash: block.hash, blockNumber: block.number };
}

export function readAt(snapshot: FinalizedSnapshot, signal: AbortSignal | undefined): ReadAt {
    return { at: snapshot.blockHash, signal };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { BlockNotPinnedError } = await import("polkadot-api");

    const BLOCK = { hash: `0x${"55".repeat(32)}`, number: 77 };
    const BEST = { hash: `0x${"77".repeat(32)}`, number: 79 };
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
                    getBestBlocks: async () => {
                        fetches += 1;
                        return [BEST, BLOCK];
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

        test("pins the finalized block when asked for finalized", async () => {
            expect(await pinBlock(fakeChain().chain, undefined, "finalized")).toEqual({
                blockHash: BLOCK.hash,
                blockNumber: BLOCK.number,
            });
        });

        test("pins the newest best block when asked for best", async () => {
            expect(await pinBlock(fakeChain().chain, undefined, "best")).toEqual({
                blockHash: BEST.hash,
                blockNumber: BEST.number,
            });
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

    describe("readPinned", () => {
        const NEWER = { hash: `0x${"99".repeat(32)}`, number: 140 };
        const NEWEST = { hash: `0x${"aa".repeat(32)}`, number: 200 };

        /**
         * A chain whose follow restarts once for each block in `finalizedAfter`. Each
         * restart drops the block the read is at and makes the next block in
         * `finalizedAfter` the finalized one.
         */
        function restartingChain(...finalizedAfter: { hash: string; number: number }[]) {
            let finalized = BLOCK;
            const seen: string[] = [];
            const chain: PinnedChain = {
                raw: {
                    individuality: {
                        getFinalizedBlock: async () => finalized,
                        getBestBlocks: async () => [finalized],
                    },
                },
            };
            const read = async (snapshot: FinalizedSnapshot) => {
                seen.push(snapshot.blockHash);
                const next = finalizedAfter.shift();
                if (next !== undefined) {
                    finalized = next;
                    throw new BlockNotPinnedError(snapshot.blockHash, "stop-storage");
                }
                return snapshot.blockNumber;
            };
            return { chain, read, seen };
        }

        test("reads again at the block pinned after PAPI dropped the first", async () => {
            const { chain, read, seen } = restartingChain(NEWER);
            expect(await readPinned(chain, undefined, undefined, read)).toBe(NEWER.number);
            expect(seen).toEqual([BLOCK.hash, NEWER.hash]);
        });

        test("follows the read across two restarts in a row", async () => {
            const { chain, read, seen } = restartingChain(NEWER, NEWEST);
            expect(await readPinned(chain, undefined, undefined, read)).toBe(NEWEST.number);
            expect(seen).toEqual([BLOCK.hash, NEWER.hash, NEWEST.hash]);
        });

        test("returns the last error after three runs", async () => {
            const LATEST = { hash: `0x${"bb".repeat(32)}`, number: 260 };
            const { chain, read, seen } = restartingChain(NEWER, NEWEST, LATEST);
            await expect(readPinned(chain, undefined, undefined, read)).rejects.toBeInstanceOf(
                BlockNotPinnedError,
            );
            expect(seen).toEqual([BLOCK.hash, NEWER.hash, NEWEST.hash]);
        });

        test("passes the error on when pinning again returns the dropped block", async () => {
            // Reading again at a block PAPI no longer holds could only fail the same way.
            const { chain, read, seen } = restartingChain(BLOCK);
            await expect(readPinned(chain, undefined, undefined, read)).rejects.toBeInstanceOf(
                BlockNotPinnedError,
            );
            expect(seen).toEqual([BLOCK.hash]);
        });

        test("passes the error on rather than replacing a caller's snapshot", async () => {
            // The caller chose the block, and may be reading others at it.
            const { chain, read, seen } = restartingChain(NEWER);
            await expect(readPinned(chain, undefined, SNAPSHOT, read)).rejects.toBeInstanceOf(
                BlockNotPinnedError,
            );
            expect(seen).toEqual([SNAPSHOT.blockHash]);
        });

        test("a composed read starts over from the read that pinned the block", async () => {
            const { chain, read, seen } = restartingChain(NEWER);
            const result = await readPinned(chain, undefined, undefined, (snapshot) =>
                readPinned(chain, undefined, snapshot, read),
            );
            expect(result).toBe(NEWER.number);
            expect(seen).toEqual([BLOCK.hash, NEWER.hash]);
        });

        test("does not read again after another failure", async () => {
            const { chain, fetches } = fakeChain();
            const read = async () => {
                throw new Error("node unreachable");
            };
            await expect(readPinned(chain, undefined, undefined, read)).rejects.toThrow(
                "node unreachable",
            );
            expect(fetches()).toBe(1);
        });
    });

    describe("readAt", () => {
        test("addresses the snapshot's hash and carries the signal", () => {
            const signal = new AbortController().signal;
            expect(readAt(SNAPSHOT, signal)).toEqual({ at: SNAPSHOT.blockHash, signal });
        });
    });
}
