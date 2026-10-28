// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { toError } from "./async-state.js";

/** A core `watch*`-style subscription: attach handlers, get back a teardown. */
export type LiveAttach<T> = (
    onValue: (value: T) => void,
    onError: (error: unknown) => void,
) => () => void;

interface LiveEntry {
    count: number;
    stop: (() => void) | undefined;
    settled: boolean;
    resolveFirst: (value: unknown) => void;
    rejectFirst: (error: Error) => void;
    first: Promise<unknown>;
    error: Error | undefined;
    errorListeners: Set<(error: Error) => void>;
}

/**
 * Refcounted registry of live subscriptions, keyed by query-key hash. The
 * framework packages use it to bridge push subscriptions into a TanStack
 * QueryClient: one host subscription per key regardless of how many
 * components mount it, values written into the query cache by the caller's
 * `sink`, and a `first` promise that serves as the query's `queryFn`.
 */
export interface LiveRegistry {
    /**
     * Promise of the first value pushed for `hash` — safe to call before the
     * subscription attaches. Rejects if the subscription errors before its
     * first value, or with `signal.reason` when the query fetch is aborted.
     */
    first<T>(hash: string, signal?: AbortSignal): Promise<T>;
    /**
     * The first acquirer opens the subscription (`attach` wired to `sink`),
     * later acquirers share it; the returned release closes it when the last
     * one leaves. `onError` is notified of subscription errors for the lifetime
     * of the acquisition (immediately, if the entry already errored).
     */
    acquire<T>(
        hash: string,
        attach: LiveAttach<T>,
        sink: (value: T) => void,
        onError: (error: Error) => void,
    ): () => void;
}

export function createLiveRegistry(): LiveRegistry {
    const entries = new Map<string, LiveEntry>();

    function ensure(hash: string): LiveEntry {
        let entry = entries.get(hash);
        if (entry) return entry;
        let resolveFirst!: (value: unknown) => void;
        let rejectFirst!: (error: Error) => void;
        const first = new Promise<unknown>((resolve, reject) => {
            resolveFirst = resolve;
            rejectFirst = reject;
        });
        first.catch(() => {}); // avoid unhandled rejection when no fetch is awaiting
        entry = {
            count: 0,
            stop: undefined,
            settled: false,
            resolveFirst,
            rejectFirst,
            first,
            error: undefined,
            errorListeners: new Set(),
        };
        entries.set(hash, entry);
        return entry;
    }

    return {
        first<T>(hash: string, signal?: AbortSignal): Promise<T> {
            const entry = ensure(hash);
            if (!signal) return entry.first as Promise<T>;
            return new Promise<T>((resolve, reject) => {
                const onAbort = () => reject(signal.reason);
                if (signal.aborted) return onAbort();
                signal.addEventListener("abort", onAbort, { once: true });
                (entry.first as Promise<T>).then(resolve, reject).finally(() => {
                    signal.removeEventListener("abort", onAbort);
                });
            });
        },

        acquire<T>(
            hash: string,
            attach: LiveAttach<T>,
            sink: (value: T) => void,
            onError: (error: Error) => void,
        ): () => void {
            const entry = ensure(hash);
            entry.count++;
            entry.errorListeners.add(onError);
            if (entry.error) onError(entry.error);

            if (!entry.stop) {
                entry.stop = attach(
                    (value) => {
                        if (!entry.settled) {
                            entry.settled = true;
                            entry.resolveFirst(value);
                        }
                        sink(value);
                    },
                    (error) => {
                        const normalized = toError(error);
                        entry.error = normalized;
                        if (!entry.settled) {
                            entry.settled = true;
                            entry.rejectFirst(normalized);
                        }
                        for (const listener of entry.errorListeners) listener(normalized);
                    },
                );
            }

            let released = false;
            return () => {
                if (released) return;
                released = true;
                entry.errorListeners.delete(onError);
                entry.count--;
                if (entry.count <= 0) {
                    entry.stop?.();
                    entries.delete(hash);
                }
            };
        },
    };
}
