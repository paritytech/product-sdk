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
import {
    getClientSync as sandboxGetClientSync,
    isCorrectEnvironment as sandboxIsCorrectEnvironment,
} from "@parity/truapi/sandbox";

import type { HostSubscription } from "./types.js";

interface TransportSubscription extends HostSubscription {
    readonly subscriptionId: string;
}

// Test-only override. When set — via `setTruApiClient`, exposed through
// `@parity/product-sdk-host/testing` — every host accessor resolves this client
// instead of the sandbox one. `null` in production, so the branches below are
// no-ops there.
let clientOverride: TrUApiClient | null = null;

function isProductionBuild(): boolean {
    try {
        // Must stay a plain `process.env.NODE_ENV` member expression: bundlers
        // (Vite, esbuild, webpack) substitute it textually, which is how this
        // check works in browser builds where `process` doesn't exist.
        return process.env.NODE_ENV === "production";
    } catch {
        // No `process` and no bundler define — can't tell, stay quiet.
        return false;
    }
}

/**
 * Test-only seam: force {@link getClient} / {@link getClientSync} to return
 * `client`, and {@link isCorrectEnvironment} to report `true`. Pass `null` to
 * restore normal detection. Exposed through `@parity/product-sdk-host/testing`,
 * not the package's main entry.
 *
 * Calling this in a production build silently reroutes every host accessor to
 * the injected client, so we warn — it almost always means a `/testing` import
 * leaked into a production path.
 */
export function setTruApiClient(client: TrUApiClient | null): void {
    if (client !== null && isProductionBuild()) {
        console.warn(
            "[product-sdk] setTruApiClient() was called in a production build. This is a test-only seam from @parity/product-sdk-host/testing; a leaked import will silently reroute all host access to the injected client.",
        );
    }
    clientOverride = client;
}

/**
 * Synchronous TruAPI client accessor. Returns the injected test client when one
 * is set, otherwise the sandbox client (`null` outside a host container).
 */
export function getClientSync(): TrUApiClient | null {
    return clientOverride ?? sandboxGetClientSync();
}

/**
 * Host-container detection. `true` when a test client is injected, otherwise the
 * sandbox heuristic (iframe / webview marker / injected message port).
 */
export function isCorrectEnvironment(): boolean {
    return clientOverride !== null || sandboxIsCorrectEnvironment();
}

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
): TransportSubscription {
    let interruptCallback: ((reason?: unknown) => void) | undefined;
    const sub = observable.subscribe({
        next: onNext,
        error: (reason) => interruptCallback?.(reason),
        complete: () => interruptCallback?.(),
    });
    return {
        subscriptionId: sub.subscriptionId,
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
    const { test, expect, afterEach } = import.meta.vitest;

    afterEach(() => setTruApiClient(null));

    // Environment detection and client building are covered by `@parity/truapi`'s
    // own sandbox tests; here we only assert the local glue degrades outside a
    // host container.
    test("getClientSync returns null outside a container", () => {
        expect(getClientSync()).toBeNull();
    });

    test("getClient resolves null outside a container", async () => {
        expect(await getClient()).toBeNull();
    });

    test("setTruApiClient overrides the client and container detection", async () => {
        const fake = {} as TrUApiClient;
        setTruApiClient(fake);
        expect(getClientSync()).toBe(fake);
        expect(await getClient()).toBe(fake);
        expect(isCorrectEnvironment()).toBe(true);

        setTruApiClient(null);
        expect(getClientSync()).toBeNull();
        expect(isCorrectEnvironment()).toBe(false);
    });

    test("setTruApiClient warns when injecting in a production build", () => {
        const original = process.env.NODE_ENV;
        const warnings: string[] = [];
        const realWarn = console.warn;
        console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
        try {
            process.env.NODE_ENV = "production";
            setTruApiClient({} as TrUApiClient);
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("production build");

            // Clearing the override must not warn.
            setTruApiClient(null);
            expect(warnings).toHaveLength(1);
        } finally {
            console.warn = realWarn;
            process.env.NODE_ENV = original;
        }
    });

    test("subscribeWithInterrupt preserves the transport subscription id", () => {
        const observable = {
            subscribe: () => ({
                subscriptionId: "p:17",
                unsubscribe: () => {},
            }),
            [Symbol.observable]() {
                return this;
            },
        } as ObservableLike<never>;

        const subscription = subscribeWithInterrupt(observable, () => {});

        expect(subscription.subscriptionId).toBe("p:17");
    });
}
