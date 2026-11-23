// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { unwrapErr, unwrapOk } from "@parity/result";
import { describe, expect, it, vi } from "vitest";
import { ReputationDecodeError, ReputationError, ReputationInputError } from "./errors.js";
import {
    readHonourTally,
    type HonourChain,
    type HonourSnapshot,
    type SubjectId,
} from "./honour.js";

const SUBJECT: SubjectId = `0x${"ab".repeat(32)}`;
const BLOCK = { hash: `0x${"12".repeat(32)}`, number: 42 };
const SNAPSHOT: HonourSnapshot = { blockHash: `0x${"34".repeat(32)}`, blockNumber: 17 };

function fakeChain(score: unknown = undefined) {
    const getFinalizedBlock = vi.fn(async () => BLOCK);
    const getValue = vi.fn(async () => score);
    const chain: HonourChain = {
        individuality: { query: { Honour: { Tally: { getValue } } } },
        raw: { individuality: { getFinalizedBlock } },
    };
    return { chain, getFinalizedBlock, getValue };
}

describe("readHonourTally", () => {
    it("reports the pallet default without inventing a storage entry", async () => {
        const { chain, getFinalizedBlock, getValue } = fakeChain();
        const result = unwrapOk(await readHonourTally(chain, SUBJECT));
        expect(result).toEqual({
            subjectId: SUBJECT,
            score: -1,
            hasStoredTally: false,
            at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
        });
        expect(getFinalizedBlock).toHaveBeenCalledOnce();
        expect(getValue).toHaveBeenCalledExactlyOnceWith(SUBJECT, {
            at: BLOCK.hash,
            signal: undefined,
        });
    });

    it.each([0, -1, -2, 3, -2_147_483_648, 2_147_483_647])(
        "preserves a stored signed 32-bit tally: %s",
        async (score) => {
            const result = unwrapOk(await readHonourTally(fakeChain(score).chain, SUBJECT));
            expect(result.score).toBe(score);
            expect(result.hasStoredTally).toBe(true);
        },
    );

    it("uses a supplied snapshot without fetching another block", async () => {
        const { chain, getFinalizedBlock, getValue } = fakeChain(2);
        const signal = new AbortController().signal;
        const result = unwrapOk(await readHonourTally(chain, SUBJECT, { at: SNAPSHOT, signal }));
        expect(result.at).toEqual(SNAPSHOT);
        expect(result.at).not.toBe(SNAPSHOT);
        expect(getFinalizedBlock).not.toHaveBeenCalled();
        expect(getValue).toHaveBeenCalledExactlyOnceWith(SUBJECT, {
            at: SNAPSHOT.blockHash,
            signal,
        });
    });

    it.each(["0x12", `0x${"ab".repeat(33)}`, `0x${"zz".repeat(32)}`, "", null, 3])(
        "rejects an invalid Subject ID before any read: %s",
        async (subjectId) => {
            const { chain, getFinalizedBlock, getValue } = fakeChain();
            expect(unwrapErr(await readHonourTally(chain, subjectId as SubjectId))).toBeInstanceOf(
                ReputationInputError,
            );
            expect(getFinalizedBlock).not.toHaveBeenCalled();
            expect(getValue).not.toHaveBeenCalled();
        },
    );

    it.each([null, "best", {}, { ...SNAPSHOT, blockNumber: -1 }, { ...SNAPSHOT, blockHash: "0x" }])(
        "rejects an invalid explicit snapshot: %s",
        async (snapshot) => {
            const { chain, getFinalizedBlock, getValue } = fakeChain();
            expect(
                unwrapErr(
                    await readHonourTally(chain, SUBJECT, { at: snapshot as HonourSnapshot }),
                ),
            ).toBeInstanceOf(ReputationInputError);
            expect(getFinalizedBlock).not.toHaveBeenCalled();
            expect(getValue).not.toHaveBeenCalled();
        },
    );

    it.each([
        null,
        "1",
        1n,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1.5,
        -2_147_483_649,
        2_147_483_648,
    ])("rejects an invalid chain tally: %s", async (score) => {
        expect(unwrapErr(await readHonourTally(fakeChain(score).chain, SUBJECT))).toBeInstanceOf(
            ReputationDecodeError,
        );
    });

    it("rejects invalid finalized block data before reading storage", async () => {
        const { chain, getFinalizedBlock, getValue } = fakeChain();
        getFinalizedBlock.mockResolvedValue({ ...BLOCK, number: Number.NaN });
        expect(unwrapErr(await readHonourTally(chain, SUBJECT))).toBeInstanceOf(
            ReputationDecodeError,
        );
        expect(getValue).not.toHaveBeenCalled();
    });

    it("returns a block lookup failure with its original cause", async () => {
        const { chain, getFinalizedBlock, getValue } = fakeChain();
        const cause = new Error("Node unavailable");
        getFinalizedBlock.mockRejectedValue(cause);
        const error = unwrapErr(await readHonourTally(chain, SUBJECT));
        expect(error).toBeInstanceOf(ReputationError);
        expect(error.cause).toBe(cause);
        expect(getValue).not.toHaveBeenCalled();
    });

    it("returns a storage failure with its original cause", async () => {
        const { chain, getValue } = fakeChain();
        const cause = new Error("Block unavailable");
        getValue.mockRejectedValue(cause);
        expect(unwrapErr(await readHonourTally(chain, SUBJECT)).cause).toBe(cause);
    });

    it("rejects an aborted call before any read", async () => {
        const { chain, getFinalizedBlock, getValue } = fakeChain();
        const controller = new AbortController();
        controller.abort(new Error("Cancelled"));
        expect(
            unwrapErr(await readHonourTally(chain, SUBJECT, { signal: controller.signal })).cause,
        ).toBe(controller.signal.reason);
        expect(getFinalizedBlock).not.toHaveBeenCalled();
        expect(getValue).not.toHaveBeenCalled();
    });

    it("stops waiting for a block when the caller aborts", async () => {
        const { chain, getFinalizedBlock, getValue } = fakeChain();
        getFinalizedBlock.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        const pending = readHonourTally(chain, SUBJECT, { signal: controller.signal });
        controller.abort(new Error("Cancelled"));
        expect(unwrapErr(await pending).cause).toBe(controller.signal.reason);
        expect(getValue).not.toHaveBeenCalled();
        expect(removed).toHaveBeenCalledOnce();
    });

    it("removes the listener when the source aborts before the listener is added", async () => {
        const { chain, getFinalizedBlock, getValue } = fakeChain();
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        getFinalizedBlock.mockImplementation(() => {
            controller.abort(new Error("Cancelled"));
            return new Promise(() => {});
        });
        expect(
            unwrapErr(await readHonourTally(chain, SUBJECT, { signal: controller.signal })).cause,
        ).toBe(controller.signal.reason);
        expect(getValue).not.toHaveBeenCalled();
        expect(removed).toHaveBeenCalledOnce();
    });

    it("stops waiting for storage when the caller aborts", async () => {
        const { chain, getValue } = fakeChain();
        getValue.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();
        const pending = readHonourTally(chain, SUBJECT, {
            at: SNAPSHOT,
            signal: controller.signal,
        });
        expect(getValue).toHaveBeenCalledOnce();
        controller.abort(new Error("Cancelled"));
        expect(unwrapErr(await pending).cause).toBe(controller.signal.reason);
    });

    it("removes abort listeners after successful reads", async () => {
        const signal = new AbortController().signal;
        const added = vi.spyOn(signal, "addEventListener");
        const removed = vi.spyOn(signal, "removeEventListener");
        unwrapOk(await readHonourTally(fakeChain(2).chain, SUBJECT, { signal }));
        expect(added).toHaveBeenCalledTimes(2);
        expect(removed).toHaveBeenCalledTimes(2);
    });
});
