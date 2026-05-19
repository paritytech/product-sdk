/**
 * Helpers for working with persisted sessions on a `TerminalAdapter`.
 */
import type { UserSession } from "@novasamatech/host-papp";

import type { TerminalAdapter } from "./adapter.js";

/**
 * Wait for the adapter to load at least one persisted session, or resolve
 * with an empty array after `timeoutMs`.
 *
 * The session manager loads sessions from storage asynchronously, so a
 * synchronous `adapter.sessions.sessions.read()` immediately after
 * `createTerminalAdapter()` may return `[]` even when sessions exist on
 * disk. Use this helper to give the loader a chance to populate before
 * deciding whether the user is logged in.
 */
export function waitForSessions(
    adapter: TerminalAdapter,
    timeoutMs = 3000,
): Promise<UserSession[]> {
    return new Promise((resolve) => {
        let resolved = false;
        let unsub: (() => void) | null = null;

        const finish = (sessions: UserSession[]) => {
            if (resolved) return;
            resolved = true;
            // Defer unsub so the synchronous initial emission can complete
            // before we tear down the subscription.
            queueMicrotask(() => unsub?.());
            resolve(sessions);
        };

        const timer = setTimeout(() => finish([]), timeoutMs);

        unsub = adapter.sessions.sessions.subscribe((sessions: UserSession[]) => {
            if (sessions.length > 0) {
                clearTimeout(timer);
                finish(sessions);
            }
        });
    });
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    type Subscriber = (sessions: UserSession[]) => void;

    function fakeAdapter(): {
        adapter: TerminalAdapter;
        emit: (sessions: UserSession[]) => void;
        subscriberCount: () => number;
    } {
        const subscribers = new Set<Subscriber>();
        const adapter = {
            sessions: {
                sessions: {
                    subscribe(cb: Subscriber) {
                        subscribers.add(cb);
                        return () => {
                            subscribers.delete(cb);
                        };
                    },
                },
            },
        } as unknown as TerminalAdapter;
        return {
            adapter,
            emit: (sessions) => {
                for (const cb of subscribers) cb(sessions);
            },
            subscriberCount: () => subscribers.size,
        };
    }

    describe("waitForSessions", () => {
        test("resolves with sessions on first non-empty emission", async () => {
            const { adapter, emit } = fakeAdapter();
            const promise = waitForSessions(adapter, 1000);
            const session = { remoteAccount: { accountId: new Uint8Array(32) } } as UserSession;
            emit([session]);
            await expect(promise).resolves.toEqual([session]);
        });

        test("ignores empty emissions and waits for a non-empty one", async () => {
            const { adapter, emit } = fakeAdapter();
            const promise = waitForSessions(adapter, 1000);
            emit([]);
            emit([]);
            const session = { remoteAccount: { accountId: new Uint8Array(32) } } as UserSession;
            emit([session]);
            await expect(promise).resolves.toEqual([session]);
        });

        test("resolves with [] after timeout when nothing is emitted", async () => {
            vi.useFakeTimers();
            try {
                const { adapter } = fakeAdapter();
                const promise = waitForSessions(adapter, 50);
                vi.advanceTimersByTime(50);
                await expect(promise).resolves.toEqual([]);
            } finally {
                vi.useRealTimers();
            }
        });

        test("unsubscribes after resolving", async () => {
            const { adapter, emit, subscriberCount } = fakeAdapter();
            const session = { remoteAccount: { accountId: new Uint8Array(32) } } as UserSession;
            const promise = waitForSessions(adapter, 1000);
            emit([session]);
            await promise;
            // Wait for queueMicrotask
            await Promise.resolve();
            expect(subscriberCount()).toBe(0);
        });

        test("uses default 3000ms timeout when none is passed", async () => {
            vi.useFakeTimers();
            try {
                const { adapter } = fakeAdapter();
                // No timeoutMs argument — exercises the `?? 3000` default branch.
                const promise = waitForSessions(adapter);
                // Just short of 3000ms: still pending.
                vi.advanceTimersByTime(2999);
                let settled = false;
                promise.then(() => {
                    settled = true;
                });
                await Promise.resolve();
                expect(settled).toBe(false);
                // Cross the default boundary.
                vi.advanceTimersByTime(1);
                await expect(promise).resolves.toEqual([]);
            } finally {
                vi.useRealTimers();
            }
        });

        test("handles synchronous initial emission", async () => {
            // Some subscribables emit current value synchronously inside subscribe().
            const session = { remoteAccount: { accountId: new Uint8Array(32) } } as UserSession;
            const adapter = {
                sessions: {
                    sessions: {
                        subscribe(cb: Subscriber) {
                            cb([session]);
                            return () => {};
                        },
                    },
                },
            } as unknown as TerminalAdapter;
            await expect(waitForSessions(adapter, 1000)).resolves.toEqual([session]);
        });
    });
}
