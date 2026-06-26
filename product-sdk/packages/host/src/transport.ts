// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Access to the in-house TruAPI client (`@parity/truapi`) for the host package.
 *
 * Environment detection and the lazily-built, cached client come from
 * `@parity/truapi/sandbox`; this module layers the product-sdk-specific glue on
 * top — an async {@link getClient} accessor and {@link subscribeWithInterrupt},
 * which adapts a truapi stream into the host's {@link HostSubscription} shape.
 *
 * @module
 */

import type { ObservableLike, TrUApiClient } from "@parity/truapi";
import { getClientSync, isCorrectEnvironment } from "@parity/truapi/sandbox";

import type { HostSubscription } from "./types.js";

export { getClientSync, isCorrectEnvironment };

/**
 * Get the TruAPI client. Returns `null` outside a host container. Async wrapper
 * over {@link getClientSync} for the host wrappers that already `await` it.
 */
export async function getClient(): Promise<TrUApiClient | null> {
    return getClientSync();
}

/**
 * Adapt a truapi `ObservableLike` stream into the host's callback-style
 * {@link HostSubscription} (`unsubscribe` + `onInterrupt`). `onNext` fires for
 * each item; the registered `onInterrupt` callback fires when the host ends the
 * subscription server-side — which the generated client surfaces as either
 * `complete` (a host interrupt frame) or `error` (transport close). Shared by
 * the statement-store and preimage adapters, which both expose this shape.
 */
export function subscribeWithInterrupt<Item, Reason = never>(
    observable: ObservableLike<Item, Reason>,
    onNext: (item: Item) => void,
): HostSubscription {
    let interruptCallback: ((reason?: unknown) => void) | undefined;
    const sub = observable.subscribe({
        next: onNext,
        error: (reason) => interruptCallback?.(reason),
        complete: () => interruptCallback?.(),
    });
    return {
        unsubscribe: () => sub.unsubscribe(),
        onInterrupt: (callback) => {
            interruptCallback = callback;
            return () => {
                if (interruptCallback === callback) interruptCallback = undefined;
            };
        },
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    // Environment detection and client building are covered by `@parity/truapi`'s
    // own sandbox tests; here we only assert the local glue degrades outside a
    // host container.
    test("getClientSync returns null outside a container", () => {
        expect(getClientSync()).toBeNull();
    });

    test("getClient resolves null outside a container", async () => {
        expect(await getClient()).toBeNull();
    });
}
