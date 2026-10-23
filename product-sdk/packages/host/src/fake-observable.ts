// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Building observables for the test fakes.
 *
 * @module
 */
import type { ObservableLike, Observer, Subscription } from "@parity/truapi";

/**
 * Wrap a `subscribe` implementation into a full `ObservableLike`. The
 * `Symbol.observable` interop member only lands on the object when the symbol
 * is polyfilled (e.g. by rxjs) — same as the generated client — and nothing in
 * the SDK reads it; it exists to satisfy the interface.
 */
export function makeObservable<Item, Reason = never>(
    subscribe: (observer?: Partial<Observer<Item, Reason>>) => Subscription,
): ObservableLike<Item, Reason> {
    const observable: ObservableLike<Item, Reason> = {
        subscribe,
        [Symbol.observable]() {
            return observable;
        },
    };
    return observable;
}
