// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { err, normalizeError, ok, type Result } from "@parity/result";
import { ReputationDecodeError, ReputationError, ReputationInputError } from "./errors.js";

export type SubjectId = `0x${string}`;

export interface HonourSnapshot {
    blockHash: string;
    blockNumber: number;
}

export interface HonourChain {
    individuality: {
        query: {
            Honour: {
                Tally: {
                    getValue(
                        subjectId: string,
                        options: { at: string; signal?: AbortSignal },
                    ): Promise<unknown>;
                };
            };
        };
    };
    raw: {
        individuality: {
            getFinalizedBlock(): Promise<{ hash: string; number: number }>;
        };
    };
}

export interface ReadHonourTallyOptions {
    at?: "finalized" | HonourSnapshot;
    signal?: AbortSignal;
}

export interface HonourTally {
    subjectId: SubjectId;
    score: number;
    hasStoredTally: boolean;
    at: HonourSnapshot;
}

const HASH_32 = /^0x[0-9a-fA-F]{64}$/;

/** Read the tally at one block. A missing entry has the pallet's default score, -1. */
export async function readHonourTally(
    chain: HonourChain,
    subjectId: SubjectId,
    options: ReadHonourTallyOptions = {},
): Promise<Result<HonourTally, ReputationError>> {
    try {
        if (typeof subjectId !== "string" || !HASH_32.test(subjectId)) {
            throw new ReputationInputError("Subject ID must contain 32 bytes of hexadecimal data");
        }
        const { signal, at } = options;
        signal?.throwIfAborted();
        let snapshot: HonourSnapshot;
        if (at === undefined || at === "finalized") {
            const block = await abortable(chain.raw.individuality.getFinalizedBlock(), signal);
            snapshot = { blockHash: block?.hash, blockNumber: block?.number };
            if (!validSnapshot(snapshot)) {
                throw new ReputationDecodeError("Finalized block has an invalid hash or number");
            }
        } else {
            if (!validSnapshot(at)) {
                throw new ReputationInputError(
                    "Snapshot must contain a block hash and block number",
                );
            }
            snapshot = { ...at };
        }
        signal?.throwIfAborted();
        const rawScore = await abortable(
            chain.individuality.query.Honour.Tally.getValue(subjectId, {
                at: snapshot.blockHash,
                signal,
            }),
            signal,
        );
        signal?.throwIfAborted();
        if (
            rawScore !== undefined &&
            (typeof rawScore !== "number" ||
                !Number.isInteger(rawScore) ||
                rawScore < -2_147_483_648 ||
                rawScore > 2_147_483_647)
        ) {
            throw new ReputationDecodeError("Honour tally must be a signed 32-bit integer");
        }
        return ok({
            subjectId,
            score: rawScore === undefined ? -1 : rawScore,
            hasStoredTally: rawScore !== undefined,
            at: snapshot,
        });
    } catch (cause) {
        return err(normalizeError(cause, ReputationError));
    }
}

function validSnapshot(value: unknown): value is HonourSnapshot {
    if (typeof value !== "object" || value === null) return false;
    const snapshot = value as HonourSnapshot;
    return (
        typeof snapshot.blockHash === "string" &&
        HASH_32.test(snapshot.blockHash) &&
        Number.isSafeInteger(snapshot.blockNumber) &&
        snapshot.blockNumber >= 0
    );
}

// The finalized-block API has no signal argument. Stop waiting when the caller aborts.
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (cause) => {
                signal.removeEventListener("abort", onAbort);
                reject(cause);
            },
        );
        if (signal.aborted) onAbort();
    });
}
