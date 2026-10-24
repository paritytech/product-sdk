// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Noticing a sign-out or an account switch while a worker runs.
 *
 * A host may keep a worker across a sign-out or an account switch, and a product
 * must never act for an identity that is no longer signed in. A product that keeps
 * per-identity state reads who is signed in, and this polls that read and reports
 * each change.
 *
 * @module
 */
import { type Clock, systemClock } from "@parity/product-sdk-utils";

/** How often {@link watchIdentity} reads by default. */
export const IDENTITY_CHECK_MS = 30_000;

/**
 * Who is signed in: an identifier the product chooses (an account, hex), `null`
 * when signed out, or `undefined` when the host could not say. An `undefined` read
 * changes nothing.
 */
export type SignedInIdentity = string | null | undefined;

/** Options of {@link watchIdentity}. */
export interface WatchIdentityOptions {
    /** The identity the product started with. */
    current: string | null;
    /** Time between reads. Default {@link IDENTITY_CHECK_MS}. */
    intervalMs?: number;
    clock?: Clock;
}

/**
 * Calls `onChange` each time `read` reports another identity, after awaiting the
 * previous `onChange`. A read that fails or answers `undefined` changes nothing.
 *
 * @returns A function that stops the watch.
 *
 * @example
 * ```ts
 * const stop = watchIdentity(readSignedInAccount, async (identity) => {
 *     await engine.stop();
 *     if (identity !== null) engine = await startFor(identity);
 * }, { current: startedFor });
 * ```
 */
export function watchIdentity(
    read: () => Promise<SignedInIdentity>,
    onChange: (identity: string | null) => Promise<void> | void,
    options: WatchIdentityOptions,
): () => void {
    const clock = options.clock ?? systemClock;
    const intervalMs = options.intervalMs ?? IDENTITY_CHECK_MS;
    let current = options.current;
    let stopped = false;

    const schedule = (): void => {
        void clock.sleep(intervalMs).then(check);
    };
    const check = async (): Promise<void> => {
        if (stopped) return;
        const identity = await read().catch(() => undefined);
        if (!stopped && identity !== undefined && identity !== current) {
            current = identity;
            await onChange(identity);
        }
        if (!stopped) schedule();
    };

    schedule();
    return () => {
        stopped = true;
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { ManualClock } = await import("@parity/product-sdk-utils/testing");

    test("reports each change, and ignores reads the host could not answer", async () => {
        const clock = new ManualClock(0);
        const answers: SignedInIdentity[] = ["alice", undefined, null, null, "bob"];
        const changes: (string | null)[] = [];
        watchIdentity(
            async () => answers.shift(),
            (identity) => {
                changes.push(identity);
            },
            { current: "alice", intervalMs: 10, clock },
        );
        await clock.advance(50);
        expect(changes).toEqual([null, "bob"]);
    });

    test("a failed read changes nothing and the watch continues", async () => {
        const clock = new ManualClock(0);
        let reads = 0;
        const changes: (string | null)[] = [];
        watchIdentity(
            async () => {
                reads++;
                if (reads === 1) throw new Error("host busy");
                return "carol";
            },
            (identity) => {
                changes.push(identity);
            },
            { current: "alice", intervalMs: 10, clock },
        );
        await clock.advance(20);
        expect(changes).toEqual(["carol"]);
    });

    test("stop ends the watch", async () => {
        const clock = new ManualClock(0);
        let reads = 0;
        const stop = watchIdentity(
            async () => {
                reads++;
                return "alice";
            },
            () => {},
            { current: "alice", intervalMs: 10, clock },
        );
        await clock.advance(10);
        stop();
        await clock.advance(100);
        expect(reads).toBe(1);
    });
}
