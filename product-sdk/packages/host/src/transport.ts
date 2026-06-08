// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Sandbox bootstrap for the in-house TruAPI client (`@parity/truapi`).
 *
 * The third-party host-api-wrapper auto-detected the host sandbox and handed
 * apps a ready-to-use `hostApi` singleton. `@parity/truapi` is lower level:
 * the product must detect its environment (iframe vs. webview), build a
 * transport provider, create the client, and run the `system.handshake`. This
 * module centralises that bootstrap and exposes the resulting client through a
 * lazy, cached singleton so the rest of `@parity/product-sdk-host` can call
 * {@link getClient} without re-implementing the wiring.
 *
 * Ported from the truapi playground's `lib/transport.ts` reference.
 *
 * @module
 */

import {
    createClient,
    createIframeProvider,
    createMessagePortProvider,
    createTransport,
    type ObservableLike,
    type Provider,
    type TrUApiClient,
    type TrUApiTransport,
} from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import type { HostSubscription } from "./types.js";

const log = createLogger("host:transport");

/** Window globals the host injects to mark / wire the embedded environment. */
type HostWindow = Record<string, unknown> & {
    __HOST_WEBVIEW_MARK__?: boolean;
    __HOST_API_PORT__?: MessagePort;
};

function hostWindow(): HostWindow | null {
    return typeof window === "undefined" ? null : (window as unknown as HostWindow);
}

/**
 * Detect whether the app is running inside a host container (iframe, webview,
 * or with an injected host message port). Synchronous so it can gate hot
 * paths. Mirrors the heuristics the previous wrapper performed internally.
 */
export function isCorrectEnvironment(): boolean {
    const win = hostWindow();
    if (!win) return false;

    // Iframe (e.g. polkadot.com browser). A cross-origin parent throws on
    // access — that itself signals we're embedded.
    try {
        if (window !== window.top) return true;
    } catch {
        return true;
    }

    // Webview (Polkadot Desktop / Mobile) marks the window and/or injects a port.
    if (win.__HOST_WEBVIEW_MARK__ === true) return true;
    if (win.__HOST_API_PORT__ != null) return true;

    return false;
}

function isIframe(): boolean {
    try {
        return window !== window.top;
    } catch {
        return true;
    }
}

/**
 * Origin used as the `targetOrigin` for outbound `postMessage` frames. Frames
 * carry signed payloads and account ids, so we refuse to fall back to `"*"`:
 * if no concrete origin can be pinned we return `null` and the provider build
 * fails closed.
 */
function resolveHostOrigin(): string | null {
    if (typeof document !== "undefined" && document.referrer) {
        try {
            return new URL(document.referrer).origin;
        } catch {
            // fall through to ancestorOrigins
        }
    }
    const ancestors = window.location?.ancestorOrigins;
    if (ancestors && ancestors.length > 0) return ancestors[0] ?? null;
    return null;
}

const WEBVIEW_PORT_TIMEOUT_MS = 20_000;

async function waitForWebviewPort(timeoutMs = WEBVIEW_PORT_TIMEOUT_MS): Promise<MessagePort> {
    const win = hostWindow();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const port = win?.__HOST_API_PORT__;
        if (port) return port;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for window.__HOST_API_PORT__ (${timeoutMs}ms)`);
}

function createSandboxProvider(): Provider {
    if (isIframe()) {
        const hostOrigin = resolveHostOrigin();
        if (!hostOrigin) {
            throw new Error(
                "TruAPI iframe provider could not resolve the host origin from document.referrer / ancestorOrigins.",
            );
        }
        return createIframeProvider({ target: window.parent, hostOrigin });
    }
    return createMessagePortProvider(waitForWebviewPort());
}

let provider: Provider | null = null;
let transport: TrUApiTransport | null = null;
let client: TrUApiClient | null = null;
let handshake: Promise<boolean> | null = null;

const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Build (or return the cached) TruAPI client without performing the handshake.
 * Returns `null` outside a host container or if the provider can't be built.
 * Use {@link getClient} for the handshake-completed client.
 */
export function getClientSync(): TrUApiClient | null {
    if (client) return client;
    if (!isCorrectEnvironment()) return null;
    try {
        provider = createSandboxProvider();
        transport = createTransport(provider);
        client = createClient(transport);
        return client;
    } catch (err) {
        log.debug("getClientSync: failed to build TruAPI client", err);
        return null;
    }
}

/**
 * Get the TruAPI client, running the `system.handshake` once and caching the
 * result. The handshake is best-effort (5s timeout): the transport
 * auto-responds to legacy host handshakes, so the client is returned even if
 * the handshake reports failure. Returns `null` outside a host container.
 */
export async function getClient(): Promise<TrUApiClient | null> {
    const c = getClientSync();
    if (!c) return null;
    if (!handshake) {
        handshake = Promise.race([
            // `.match` returns a real Promise<boolean>; ResultAsync routes both
            // the Err channel and any thrown rejection through the error arm.
            c.system
                .handshake()
                .match(
                    () => true,
                    () => false,
                ),
            new Promise<boolean>((resolve) =>
                setTimeout(() => resolve(false), HANDSHAKE_TIMEOUT_MS),
            ),
        ]);
    }
    await handshake;
    return c;
}

/** Whether the host connection is up and the handshake has succeeded. */
export async function isReady(): Promise<boolean> {
    if (!getClientSync()) return false;
    await getClient();
    return (await handshake) ?? false;
}

/**
 * Adapt a truapi `ObservableLike` stream into the host's callback-style
 * {@link HostSubscription} (`unsubscribe` + `onInterrupt`). `onNext` fires for
 * each item; the registered `onInterrupt` callback fires when the host ends the
 * subscription server-side — which the generated client surfaces as either
 * `complete` (a host interrupt frame) or `error` (transport close). Shared by
 * the statement-store and preimage adapters, which both expose this shape.
 */
export function subscribeWithInterrupt<Item>(
    observable: ObservableLike<Item>,
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

/** Tear down the cached client/transport/provider. Primarily for tests. */
export function disposeClient(): void {
    try {
        transport?.dispose();
    } catch {
        // best effort
    }
    try {
        provider?.dispose();
    } catch {
        // best effort
    }
    provider = null;
    transport = null;
    client = null;
    handshake = null;
}

if (import.meta.vitest) {
    const { test, expect, vi, afterEach } = import.meta.vitest;

    afterEach(() => {
        disposeClient();
        vi.unstubAllGlobals();
    });

    test("isCorrectEnvironment is false without a window", () => {
        expect(isCorrectEnvironment()).toBe(false);
    });

    test("isCorrectEnvironment detects an iframe (window !== window.top)", () => {
        vi.stubGlobal("window", { top: {} });
        expect(isCorrectEnvironment()).toBe(true);
    });

    test("isCorrectEnvironment detects a cross-origin iframe (top throws)", () => {
        const win = {};
        Object.defineProperty(win, "top", {
            get() {
                throw new DOMException("cross-origin");
            },
        });
        vi.stubGlobal("window", win);
        expect(isCorrectEnvironment()).toBe(true);
    });

    test("isCorrectEnvironment detects the webview mark", () => {
        const win = {};
        Object.defineProperty(win, "top", { get: () => win });
        (win as Record<string, unknown>).__HOST_WEBVIEW_MARK__ = true;
        vi.stubGlobal("window", win);
        expect(isCorrectEnvironment()).toBe(true);
    });

    test("isCorrectEnvironment detects an injected host port", () => {
        const win = {};
        Object.defineProperty(win, "top", { get: () => win });
        (win as Record<string, unknown>).__HOST_API_PORT__ = {};
        vi.stubGlobal("window", win);
        expect(isCorrectEnvironment()).toBe(true);
    });

    test("isCorrectEnvironment is false for a standalone top-level window", () => {
        const win = {};
        Object.defineProperty(win, "top", { get: () => win });
        vi.stubGlobal("window", win);
        expect(isCorrectEnvironment()).toBe(false);
    });

    test("getClientSync returns null outside a container", () => {
        expect(getClientSync()).toBeNull();
    });

    test("isReady returns false outside a container", async () => {
        expect(await isReady()).toBe(false);
    });
}
