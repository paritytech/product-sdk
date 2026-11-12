// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
export interface ReadonlyStore<T> {
    get(): T;
    subscribe(listener: (value: T) => void): () => void;
}

export interface Store<T> extends ReadonlyStore<T> {
    set(next: T | ((prev: T) => T)): void;
}

export function createStore<T>(initial: T): Store<T> {
    let value = initial;
    const listeners = new Set<(value: T) => void>();
    return {
        get: () => value,
        set: (next) => {
            const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
            if (Object.is(resolved, value)) return;
            value = resolved;
            for (const listener of [...listeners]) listener(value);
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

/**
 * A store whose upstream subscription only runs while someone is listening.
 * `start` receives a setter and returns a teardown; it is invoked when the
 * first subscriber arrives and torn down when the last one leaves.
 */
export function createLazyStore<T>(
    initial: T,
    start: (set: (next: T | ((prev: T) => T)) => void) => (() => void) | undefined,
): ReadonlyStore<T> {
    const inner = createStore(initial);
    let active = 0;
    let stop: (() => void) | undefined;
    return {
        get: inner.get,
        subscribe: (listener) => {
            const unsubscribe = inner.subscribe(listener);
            if (active++ === 0) stop = start(inner.set);
            let closed = false;
            return () => {
                if (closed) return;
                closed = true;
                unsubscribe();
                if (--active === 0) {
                    stop?.();
                    stop = undefined;
                }
            };
        },
    };
}
