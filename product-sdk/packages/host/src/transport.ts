// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Access to the in-house TruAPI client (`@parity/truapi`) for the host package.
 *
 * Environment detection, the lazily-built cached client, and the connection-status
 * signal come from `@parity/truapi/sandbox`; this module layers the
 * product-sdk-specific glue on top — an async {@link getClient} accessor,
 * {@link subscribeConnectionStatus}, and {@link subscribeWithInterrupt}, which
 * adapts a truapi stream into the host's {@link HostSubscription} shape.
 *
 * @module
 */

import type { ObservableLike, TrUApiClient } from "@parity/truapi";
import {
    type ConnectionStatus,
    getClientSync as sandboxGetClientSync,
    isCorrectEnvironment as sandboxIsCorrectEnvironment,
    subscribeConnectionStatus as sandboxSubscribeConnectionStatus,
} from "@parity/truapi/sandbox";

import type { HostSubscription } from "./types.js";

/** A {@link HostSubscription} carrying the transport-assigned subscription id. */
export interface TransportSubscription extends HostSubscription {
    readonly subscriptionId: string;
}

// Test-only override. When set — via `setTruApiClient`, exposed through
// `@parity/product-sdk-host/testing` — every host accessor resolves this client
// instead of the sandbox one. `null` in production, so the branches below are
// no-ops there.
let clientOverride: TrUApiClient | null = null;

// Status subscribers registered here rather than only in the sandbox, so that
// flipping the test seam is an *event*. The sandbox tracks only the client it
// built itself, so it cannot know an injected client appeared or went away.
const localStatusListeners = new Set<(status: HostConnectionStatus) => void>();

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
 *
 * Injecting or clearing notifies {@link subscribeConnectionStatus} subscribers,
 * so a product's "host lost" path can be exercised by disposing the fake host.
 */
export function setTruApiClient(client: TrUApiClient | null): void {
    if (client !== null && isProductionBuild()) {
        console.warn(
            "[product-sdk] setTruApiClient() was called in a production build. This is a test-only seam from @parity/product-sdk-host/testing; a leaked import will silently reroute all host access to the injected client.",
        );
    }
    const wasOverridden = clientOverride !== null;
    clientOverride = client;
    if (wasOverridden !== (client !== null)) {
        notifyLocalStatusListeners(client !== null ? "connected" : "disconnected");
    }
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
 * Connection lifecycle of the host channel: `"connecting"` while the client waits
 * for the host, `"connected"` once the channel is established, `"disconnected"`
 * outside a host container or after the channel closes.
 *
 * Not the same concept as `@parity/product-sdk-signer`'s identically-shaped
 * `ConnectionStatus`, which tracks a signer provider rather than the transport.
 */
export type HostConnectionStatus = ConnectionStatus;

/**
 * Correct one defect in the sandbox's status signal: `@parity/truapi` never clears
 * its cached client when the pipe closes, so a subscriber arriving after a
 * disconnect re-derives `"connecting"` from the dead client — and because the
 * sandbox fans every change out to all listeners, that rewrites everyone's state
 * with no way back. Hold `"disconnected"` until a real `"connected"` arrives.
 *
 * Applies to sandbox-sourced statuses only. A status pushed by the test seam is
 * deliberate and passes through, so a fake host can still drive a reconnect.
 *
 * Outstanding upstream, not tied to the version we happen to be on: `sandbox.js`
 * is byte-identical from 0.7.0 through 0.9.0 (npm latest) and still unfixed on
 * `paritytech/host-rust-core` main, the repo formerly named truapi. Remove once
 * it clears the cached client on close.
 */
function latchDisconnected(
    previous: HostConnectionStatus | null,
    next: HostConnectionStatus,
): HostConnectionStatus {
    return next === "connecting" && previous === "disconnected" ? "disconnected" : next;
}

function notifyLocalStatusListeners(status: HostConnectionStatus): void {
    // Iterate a snapshot: a listener that unsubscribes itself, or re-enters
    // `setTruApiClient`, must not mutate the set mid-loop.
    for (const listener of [...localStatusListeners]) listener(status);
}

/**
 * Test-only: push `status` to every {@link subscribeConnectionStatus} subscriber,
 * so a product can exercise its reconnecting / offline UI. The host-side
 * counterpart of `@parity/product-sdk-signer`'s `FakeSignerProvider.emitStatus`.
 * Exposed through `@parity/product-sdk-host/testing`, not the main entry.
 */
export function emitConnectionStatus(status: HostConnectionStatus): void {
    if (isProductionBuild()) {
        console.warn(
            "[product-sdk] emitConnectionStatus() was called in a production build. This is a test-only seam from @parity/product-sdk-host/testing; a leaked import will report a fabricated connection status to real subscribers.",
        );
    }
    notifyLocalStatusListeners(status);
}

/**
 * Subscribe to host-channel connection status. The callback fires synchronously
 * with the current status and again on every change; the returned function
 * unsubscribes. Repeats of the status you already have are suppressed.
 *
 * This is the **transport** channel. For the host's account-level connection —
 * what drives `@parity/product-sdk-signer`'s `ConnectionStatus` — use
 * `AccountsProvider.subscribeAccountConnectionStatus` instead.
 *
 * Subscribing is not passive: outside an established channel the first subscribe
 * builds the client and provider, so this can be what constructs the transport.
 *
 * Honours the `setTruApiClient` seam — an injected client is connected by
 * definition, and injecting or clearing one notifies live subscribers.
 */
export function subscribeConnectionStatus(
    callback: (status: HostConnectionStatus) => void,
): () => void {
    let last: HostConnectionStatus | null = null;

    // One wrapped callback for both sources, so `last` stays coherent: the seam
    // and the sandbox must not each keep their own idea of what was delivered.
    const deliver = (status: HostConnectionStatus, fromSandbox: boolean): void => {
        const next = fromSandbox ? latchDisconnected(last, status) : status;
        if (next === last) return;
        last = next;
        callback(next);
    };

    const onLocal = (status: HostConnectionStatus) => deliver(status, false);
    localStatusListeners.add(onLocal);

    if (clientOverride !== null) {
        onLocal("connected");
        return () => void localStatusListeners.delete(onLocal);
    }

    const unsubscribeSandbox = sandboxSubscribeConnectionStatus((status) => deliver(status, true));
    return () => {
        localStatusListeners.delete(onLocal);
        unsubscribeSandbox();
    };
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

    test("subscribeConnectionStatus reports disconnected outside a container", () => {
        const statuses: HostConnectionStatus[] = [];

        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        expect(statuses).toEqual(["disconnected"]);
        unsubscribe();
    });

    test("subscribeConnectionStatus reports connected for an injected client", () => {
        setTruApiClient({} as TrUApiClient);
        const statuses: HostConnectionStatus[] = [];

        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        // The sandbox only tracks the client it built itself, so without the
        // override branch this would report "disconnected" while every other
        // accessor resolved the injected client.
        expect(statuses).toEqual(["connected"]);
        unsubscribe();
    });

    test("disposing the injected client notifies live subscribers", () => {
        setTruApiClient({} as TrUApiClient);
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        setTruApiClient(null);

        expect(statuses).toEqual(["connected", "disconnected"]);
        unsubscribe();
    });

    test("injecting a client notifies subscribers that started without one", () => {
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        setTruApiClient({} as TrUApiClient);

        expect(statuses).toEqual(["disconnected", "connected"]);
        unsubscribe();
    });

    test("unsubscribe stops seam notifications", () => {
        setTruApiClient({} as TrUApiClient);
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        unsubscribe();
        setTruApiClient(null);

        expect(statuses).toEqual(["connected"]);
        expect(localStatusListeners.size).toBe(0);
    });

    test("emitConnectionStatus drives transitions, including a reconnect", () => {
        setTruApiClient({} as TrUApiClient);
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        emitConnectionStatus("disconnected");
        // A seam-pushed "connecting" after "disconnected" is deliberate, so it must
        // survive the sandbox latch — otherwise no test could drive a reconnect.
        emitConnectionStatus("connecting");
        emitConnectionStatus("connected");

        expect(statuses).toEqual(["connected", "disconnected", "connecting", "connected"]);
        unsubscribe();
    });

    test("repeats of the current status are suppressed", () => {
        setTruApiClient({} as TrUApiClient);
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        emitConnectionStatus("connected");
        emitConnectionStatus("connected");

        expect(statuses).toEqual(["connected"]);
        unsubscribe();
    });

    test("a listener that unsubscribes itself mid-notification is safe", () => {
        setTruApiClient({} as TrUApiClient);
        const statuses: HostConnectionStatus[] = [];
        const handle: { unsubscribe?: () => void } = {};
        handle.unsubscribe = subscribeConnectionStatus((status) => {
            statuses.push(status);
            handle.unsubscribe?.();
        });

        setTruApiClient(null);

        expect(statuses).toEqual(["connected", "disconnected"]);
        expect(localStatusListeners.size).toBe(0);
    });

    // The sandbox latch can't be driven through the public surface — it needs a
    // real provider close — so the correction is pinned as a pure function.
    test("latchDisconnected holds disconnected through the stale-cache connecting", () => {
        expect(latchDisconnected("disconnected", "connecting")).toBe("disconnected");
    });

    test("latchDisconnected passes every other transition through", () => {
        expect(latchDisconnected(null, "disconnected")).toBe("disconnected");
        expect(latchDisconnected(null, "connecting")).toBe("connecting");
        expect(latchDisconnected("connecting", "connected")).toBe("connected");
        expect(latchDisconnected("connected", "disconnected")).toBe("disconnected");
        // A genuine reconnect still gets through once the channel re-establishes.
        expect(latchDisconnected("connected", "connecting")).toBe("connecting");
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
