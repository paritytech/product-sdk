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
import { HostError, HostUnavailableError } from "./errors.js";

/** A {@link HostSubscription} carrying the transport-assigned subscription id. */
export interface TransportSubscription extends HostSubscription {
    readonly subscriptionId: string;
}

// Test-only override. When set — via `setTruApiClient`, exposed through
// `@parity/product-sdk-host/testing` — every host accessor resolves this client
// instead of the sandbox one. `null` in production, so the branches below are
// no-ops there.
let clientOverride: TrUApiClient | null = null;

/** A ready, externally owned host connection. */
export interface HostBindingOptions {
    client: TrUApiClient;
    /** Aborted by the connection owner when its transport closes. */
    signal: AbortSignal;
    /** Exact bundled @parity/truapi version. Stable 0.17.x is supported. */
    apiVersion: string;
}

let boundHost: (HostBindingOptions & { unbind(): void }) | null = null;

/**
 * Borrow a ready host client. Call before using SDK host accessors.
 * The owner retains transport ownership; unbinding never closes it.
 * Rebinding the same client and signal returns the same unbind function.
 */
export function bindHost(options: HostBindingOptions): () => void {
    const { client, signal, apiVersion } = options;
    if (!/^0\.17\.(0|[1-9]\d*)(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(apiVersion)) {
        throw new HostError(
            `Host TrUAPI ${JSON.stringify(apiVersion)} is unsupported. This SDK supports stable 0.17.x. Update this project's @parity/product-sdk or use a compatible host.`,
        );
    }
    if (signal.aborted) throw new HostUnavailableError("Cannot bind a disconnected host");
    if (boundHost) {
        if (boundHost.client === client && boundHost.signal === signal) return boundHost.unbind;
        throw new HostError("Unbind the current host before binding another connection");
    }

    const binding = {
        ...options,
        unbind() {
            if (boundHost !== binding) return;
            signal.removeEventListener("abort", binding.unbind);
            boundHost = null;
            notifyLocalStatusListeners(null);
        },
    };
    boundHost = binding;
    signal.addEventListener("abort", binding.unbind, { once: true });
    notifyLocalStatusListeners(null);
    return binding.unbind;
}

// Status subscribers registered here rather than only in the sandbox, so that
// flipping the test seam is an *event*. The sandbox tracks only the client it
// built itself, so it cannot know an injected client appeared or went away.
const localStatusListeners = new Set<(status: HostConnectionStatus | null) => void>();

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
        notifyLocalStatusListeners(null);
    }
}

/**
 * Test overrides take precedence over an explicit binding, then browser discovery.
 */
export function getClientSync(): TrUApiClient | null {
    return clientOverride ?? boundHost?.client ?? sandboxGetClientSync();
}

/**
 * Host availability, including an explicit binding or test override.
 */
export function isCorrectEnvironment(): boolean {
    return clientOverride !== null || boundHost !== null || sandboxIsCorrectEnvironment();
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

function notifyLocalStatusListeners(status: HostConnectionStatus | null): void {
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
 * Bound clients are connected until their signal aborts or they are unbound.
 * Test overrides take precedence over both explicit bindings and the sandbox.
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

    let unsubscribeSandbox: (() => void) | undefined;
    const onLocal = (status: HostConnectionStatus | null): void => {
        if (status !== null) {
            deliver(status, false);
            return;
        }
        unsubscribeSandbox?.();
        unsubscribeSandbox = undefined;
        if (clientOverride !== null || boundHost !== null) {
            deliver("connected", false);
        } else {
            unsubscribeSandbox = sandboxSubscribeConnectionStatus((next) => {
                if (clientOverride === null && boundHost === null) deliver(next, true);
            });
        }
    };
    localStatusListeners.add(onLocal);
    onLocal(null);
    return () => {
        localStatusListeners.delete(onLocal);
        unsubscribeSandbox?.();
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
    const { test, expect, afterEach, vi } = import.meta.vitest;
    const bindingCleanups: Array<() => void> = [];

    function bind(client: TrUApiClient, controller = new AbortController(), apiVersion = "0.17.0") {
        const unbind = bindHost({ client, signal: controller.signal, apiVersion });
        bindingCleanups.push(unbind);
        return unbind;
    }

    afterEach(() => {
        for (const unbind of bindingCleanups.splice(0)) unbind();
        setTruApiClient(null);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test("binding borrows the ready client without creating a sandbox transport", async () => {
        const client = {} as TrUApiClient;
        const windowAccess = vi.fn();
        vi.stubGlobal("window", new Proxy({}, { get: windowAccess }));
        bind(client);
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        expect([getClientSync(), await getClient(), isCorrectEnvironment(), statuses]).toEqual([
            client,
            client,
            true,
            ["connected"],
        ]);
        expect(windowAccess).not.toHaveBeenCalled();
        unsubscribe();
    });

    test.each(["0.17.0", "0.17.9", "0.17.2+build.1"])(
        "binding accepts stable TrUAPI %s",
        (version) => {
            const client = {} as TrUApiClient;
            bind(client, new AbortController(), version);
            expect(getClientSync()).toBe(client);
        },
    );

    test.each(["0.16.9", "0.18.0", "1.17.0", "0.17.0-rc.1", "0.17.01", "0.17", ""])(
        "binding rejects unsupported TrUAPI %s before reporting connected",
        (version) => {
            const statuses: HostConnectionStatus[] = [];
            const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

            expect(() => bind({} as TrUApiClient, new AbortController(), version)).toThrow(
                `Host TrUAPI ${JSON.stringify(version)} is unsupported. This SDK supports stable 0.17.x. Update this project's @parity/product-sdk or use a compatible host.`,
            );
            expect([getClientSync(), isCorrectEnvironment(), statuses]).toEqual([
                null,
                false,
                ["disconnected"],
            ]);
            unsubscribe();
        },
    );

    test("a disconnected host cannot become the SDK client", () => {
        const controller = new AbortController();
        controller.abort();

        expect(() => bind({} as TrUApiClient, controller)).toThrow(
            "Cannot bind a disconnected host",
        );
        expect([getClientSync(), isCorrectEnvironment()]).toEqual([null, false]);
    });

    test.each(["abort", "unbind"])(
        "%s releases the client and abort listener exactly once",
        (action) => {
            const controller = new AbortController();
            const removeListener = vi.spyOn(controller.signal, "removeEventListener");
            const unbind = bind({} as TrUApiClient, controller);
            const statuses: HostConnectionStatus[] = [];
            const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

            if (action === "abort") controller.abort();
            else unbind();
            unbind();
            controller.abort();

            expect([
                getClientSync(),
                isCorrectEnvironment(),
                statuses,
                removeListener.mock.calls.length,
            ]).toEqual([null, false, ["connected", "disconnected"], 1]);
            unsubscribe();
        },
    );

    test("binding notifies existing listeners and cannot replace another live connection", () => {
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));
        const client = {} as TrUApiClient;
        const controller = new AbortController();
        const unbind = bind(client, controller);

        expect(bind(client, controller)).toBe(unbind);
        expect(() => bind({} as TrUApiClient)).toThrow(
            "Unbind the current host before binding another connection",
        );
        expect(() => bind(client)).toThrow(
            "Unbind the current host before binding another connection",
        );
        expect([getClientSync(), statuses]).toEqual([client, ["disconnected", "connected"]]);
        unbind();
        const replacement = {} as TrUApiClient;
        bind(replacement);
        unbind();
        expect(getClientSync()).toBe(replacement);
        unsubscribe();
    });

    test("test overrides take precedence without losing the real binding", () => {
        const client = {} as TrUApiClient;
        const fake = {} as TrUApiClient;
        const controller = new AbortController();
        bind(client, controller);
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));

        setTruApiClient(fake);
        expect(getClientSync()).toBe(fake);
        setTruApiClient(null);
        expect([getClientSync(), statuses]).toEqual([client, ["connected"]]);
        setTruApiClient(fake);
        controller.abort();
        expect([getClientSync(), statuses]).toEqual([fake, ["connected"]]);
        setTruApiClient(null);
        expect(statuses).toEqual(["connected", "disconnected"]);
        unsubscribe();
    });

    test("unbinding resumes browser status and ignores browser changes while bound", async () => {
        const makePort = () => ({
            start: vi.fn(),
            postMessage: vi.fn(),
            close: vi.fn(),
            onmessageerror: null as (() => void) | null,
        });
        const firstPort = makePort();
        const window = {
            __HOST_API_PORT__: firstPort,
            get top() {
                return this;
            },
        };
        vi.stubGlobal("window", window);
        const statuses: HostConnectionStatus[] = [];
        const unsubscribe = subscribeConnectionStatus((status) => statuses.push(status));
        await vi.waitFor(() => expect(firstPort.start).toHaveBeenCalledOnce());
        const unbind = bind({} as TrUApiClient);
        firstPort.onmessageerror?.();
        expect(statuses).toEqual(["connecting", "connected"]);

        const secondPort = makePort();
        window.__HOST_API_PORT__ = secondPort;
        unbind();
        await vi.waitFor(() => expect(secondPort.start).toHaveBeenCalledOnce());
        secondPort.onmessageerror?.();
        expect(statuses).toEqual([
            "connecting",
            "connected",
            "connecting",
            "connected",
            "disconnected",
        ]);
        unsubscribe();
    });

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
