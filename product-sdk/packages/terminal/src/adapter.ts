// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Node.js adapter for the Polkadot host-papp SDK.
 *
 * Provides Node.js-compatible implementations of the SDK's storage and
 * transport layers, enabling QR login, attestation, and signing in
 * terminal/CLI environments.
 */
import {
    createPappAdapter,
    type PappAdapter,
    type HostMetadata,
    SS_STABLE_STAGE_ENDPOINTS,
    SS_PASEO_STABLE_STAGE_ENDPOINTS,
} from "@novasamatech/host-papp";
import {
    createLazyClient,
    createPapiStatementStoreAdapter,
    type LazyClient,
} from "@novasamatech/statement-store";
import { createLogger } from "@parity/product-sdk-logger";
import { getWsProvider } from "@polkadot-api/ws-provider";

import { createNodeStorageAdapter } from "./node-storage.js";

const log = createLogger("terminal");

/** Options for creating a terminal adapter. */
export interface TerminalAdapterOptions {
    /** Unique app identifier. Used as the storage namespace. */
    appId: string;
    /** Statement store WebSocket endpoints. Defaults to Paseo stable endpoints. */
    endpoints?: string[];
    /** Optional host metadata for the Sign-In screen. */
    hostMetadata?: HostMetadata;
    /**
     * Directory where session files are persisted. Defaults to
     * `~/.polkadot-apps/`. Override in tests to point at a temporary
     * directory populated with `createTestSession` from
     * `@parity/product-sdk-terminal/testing`.
     */
    storageDir?: string;
}

/**
 * Create a terminal adapter backed by the host-papp SDK.
 *
 * This sets up:
 * - File-based storage in `~/.polkadot-apps/` (since Node.js has no localStorage)
 * - WebSocket connection to the statement store
 * - The full SSO flow: QR pairing + on-chain attestation
 * - Session manager for signing requests
 */
/** A PappAdapter with the `appId` it was created with and a `destroy` method for cleanup. */
export type TerminalAdapter = PappAdapter & {
    /** The `appId` passed to {@link createTerminalAdapter}. Useful for {@link createSessionSigner}. */
    readonly appId: string;
    /**
     * The on-disk storage directory used for sessions and (when the
     * host-runner facet is in use) for the allowance-key cache the
     * `./host` subpath maintains. `undefined` when the default
     * is in use; set explicitly when the caller passed `storageDir` to
     * {@link createTerminalAdapter}.
     */
    readonly storageDir?: string;
    /**
     * Disconnect the WebSocket and release resources.
     *
     * @remarks
     * Idempotent. Returns a Promise that resolves once all in-flight
     * statement-subscription teardowns have settled and the underlying
     * substrate client has been disconnected. **Awaiting is recommended
     * but not required** — callers that don't await get the same
     * fire-and-forget shape the previous version had, but they may see
     * the destroy-time RPC traffic finish after the function returns.
     *
     * The implementation tracks the server-side `statement_unsubscribe…`
     * RPCs `sessions.dispose()` fires, then awaits them via
     * `Promise.allSettled` before destroying the substrate-client request
     * queue. Draining those RPCs is not enough on its own: destroying the
     * client while a statement-subscription observable is still live makes
     * `@novasamatech/statement-store` log `Statement subscription error:
     * DestroyedError` to `console.error` from a detached finalizer, often
     * after this Promise resolves. So the disconnect and a short tail past
     * it run under a scoped `console.error` filter that drops only that
     * benign line ({@link isBenignTeardownError}) and restores itself
     * afterward — every other `console.error` passes through.
     */
    destroy(): Promise<void>;
};

export function createTerminalAdapter(options: TerminalAdapterOptions): TerminalAdapter {
    const endpoints = options.endpoints ?? SS_PASEO_STABLE_STAGE_ENDPOINTS;

    const storage = createNodeStorageAdapter(options.appId, options.storageDir);
    // ws-provider 0.9 takes endpoints positionally; relies on the global
    // WebSocket (Node ≥21) unless `websocketClass` is supplied.
    //
    // heartbeatTimeout uses setTimeout under the hood, which clamps to a
    // 32-bit signed integer. Passing Infinity triggers a noisy
    // `TimeoutOverflowWarning` on every reschedule. Use the int32 max
    // (~24.8 days) — effectively-never for any CLI session.
    const HEARTBEAT_NEVER_MS = 2_147_483_647;
    const rawLazyClient = createLazyClient(
        getWsProvider(endpoints, { heartbeatTimeout: HEARTBEAT_NEVER_MS }),
    );
    const trackedLazyClient = wrapLazyClient(rawLazyClient);
    const statementStore = createPapiStatementStoreAdapter(trackedLazyClient);

    const adapter = createPappAdapter({
        appId: options.appId,
        hostMetadata: options.hostMetadata,
        adapters: {
            storage,
            lazyClient: trackedLazyClient,
            statementStore,
        },
    });

    let destroyPromise: Promise<void> | null = null;
    return {
        ...adapter,
        appId: options.appId,
        storageDir: options.storageDir,
        destroy(): Promise<void> {
            if (destroyPromise) return destroyPromise;
            destroyPromise = teardown(adapter.sessions, trackedLazyClient);
            return destroyPromise;
        },
    };
}

/**
 * Lazy-client wrapper that tracks server-side unsubscribe RPCs as Promises.
 *
 * `lazyClient.getSubscribeFn` returns a function whose teardown callback
 * fires `c._request(unsubscribeMethod, ...)` with `noop` `onSuccess` /
 * `onError` — the unsubscribe is fire-and-forget by upstream design. We
 * intercept those requests by replacing their callbacks with handlers
 * that resolve a tracking Promise on either outcome (success OR error —
 * we just need to know the request settled, not whether it succeeded).
 *
 * `awaitPendingUnsubs()` returns a Promise that settles when every
 * tracked unsubscribe has completed. Used by `teardown` to drain before
 * calling `disconnect`.
 *
 * The wrapper is otherwise transparent: `getClient`, `getRequestFn`,
 * `disconnect` pass through unchanged.
 */
type TrackedLazyClient = LazyClient & {
    awaitPendingUnsubs(): Promise<void>;
};

function wrapLazyClient(inner: LazyClient): TrackedLazyClient {
    const pendingUnsubs = new Set<Promise<void>>();
    const innerGetSubscribeFn = inner.getSubscribeFn.bind(inner);

    return {
        ...inner,
        getClient: inner.getClient.bind(inner),
        getRequestFn: inner.getRequestFn.bind(inner),
        disconnect: inner.disconnect.bind(inner),

        getSubscribeFn() {
            // Each call returns a new SubscribeFn. We wrap the teardown
            // callback so any unsubscribe RPC it fires gets tracked.
            const innerSubscribe = innerGetSubscribeFn();
            return ((method, params, onMessage, onError) => {
                const innerTeardown = innerSubscribe(method, params, onMessage, onError);
                return () => {
                    // Track the unsubscribe with a Promise that resolves
                    // after the microtask queue drains. The upstream code
                    // uses `noop` callbacks on the actual RPC, so we
                    // can't directly observe completion — but by the
                    // time `innerTeardown()` returns, the `_request`
                    // has been queued. Two microtask hops are enough
                    // for the request to flush through the
                    // substrate-client's send pipeline.
                    //
                    // If `innerTeardown()` throws synchronously, we let
                    // the throw escape (the caller — `sessions.dispose()`
                    // — is in the best position to decide what to do)
                    // but the tracker still resolves so
                    // `awaitPendingUnsubs()` doesn't hang and
                    // `destroy()` still completes.
                    const tracked = new Promise<void>((resolve) => {
                        queueMicrotask(() => queueMicrotask(resolve));
                    });
                    pendingUnsubs.add(tracked);
                    void tracked.finally(() => pendingUnsubs.delete(tracked));
                    innerTeardown();
                };
            }) as ReturnType<LazyClient["getSubscribeFn"]>;
        },

        async awaitPendingUnsubs(): Promise<void> {
            // Snapshot so additions made during the await don't extend
            // the wait indefinitely (sessions.dispose() should have fired
            // them all synchronously by the time we're called).
            const snapshot = Array.from(pendingUnsubs);
            await Promise.allSettled(snapshot);
        },
    };
}

/**
 * Whether `error` is the benign teardown noise `@novasamatech/statement-store`
 * emits when a statement subscription's observable errors because the client
 * was destroyed underneath it (`DestroyedError: Client destroyed`).
 *
 * Exported so consumers wiring their own subscription `onError` handlers, or
 * their own `console.error` guards, can drop this one line without reinventing
 * the regex. {@link createTerminalAdapter}'s own `destroy()` already suppresses
 * it (see {@link suppressBenignTeardownErrors}); this is for code paths outside
 * that window.
 */
export function isBenignTeardownError(error: unknown): boolean {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return /DestroyedError|Client destroyed/.test(text);
}

/**
 * Temporarily drop {@link isBenignTeardownError} lines from `console.error`,
 * returning a restore function.
 *
 * The noise comes from an unconditional `console.error('Statement subscription
 * error:', …)` inside `@novasamatech/statement-store`'s rpc adapter, fired from
 * a detached rxjs finalizer when `disconnect()` destroys the client while a
 * subscription is still live. Draining the tracked unsubscribe RPCs does not
 * cover that observable's error emission, so the ordering-only approach still
 * lets one line through — hence a scoped suppression.
 *
 * Deliberately narrow: only calls whose first argument matches the benign
 * pattern are dropped; every other `console.error` passes through untouched, so
 * a genuine error during teardown is still visible.
 */
function suppressBenignTeardownErrors(): () => void {
    const original = console.error;
    const wrapper = (...args: unknown[]) => {
        if (args.some(isBenignTeardownError)) return;
        original.apply(console, args as Parameters<typeof console.error>);
    };
    console.error = wrapper;
    // Restore only if we're still the active wrapper — if another patcher
    // layered on top after us, resetting to `original` would clobber theirs.
    return () => {
        if (console.error === wrapper) console.error = original;
    };
}

/**
 * Drain pending unsubscribes, then disconnect. Order is deterministic:
 *
 *   1. `sessions.dispose()` walks each open statement-subscription and
 *      triggers their RPC unsubscribe via the wrapped subscribe-fn's
 *      teardown callback. Each unsubscribe is recorded as a tracked
 *      Promise on the wrapper.
 *   2. `awaitPendingUnsubs()` waits for those tracked Promises to
 *      settle (resolution OR rejection — we just need confirmation the
 *      RPC has left the substrate-client send pipeline).
 *   3. `disconnect()` calls `substrateClient.destroy()`.
 *
 * Draining the unsubscribe RPCs does not stop `@novasamatech/statement-store`
 * from logging `Statement subscription error: DestroyedError` when the client
 * is destroyed while a subscription observable is still live — that log fires
 * from a detached finalizer, often after this function resolves. So the
 * disconnect (and a short tail past it) runs under a scoped
 * {@link suppressBenignTeardownErrors}; only the benign line is dropped.
 *
 * If the disconnect call itself throws, log and continue rather than
 * propagating — caller can `await destroy()` without `try/catch`.
 */
async function teardown(
    sessions: { dispose(): void },
    lazyClient: TrackedLazyClient,
): Promise<void> {
    log.debug("destroying terminal adapter");
    sessions.dispose();
    await lazyClient.awaitPendingUnsubs();
    const restore = suppressBenignTeardownErrors();
    try {
        lazyClient.disconnect();
    } catch (e) {
        log.warn("lazyClient.disconnect threw during destroy", { error: e });
    }
    // The finalizer that logs the benign error can fire a few microtasks after
    // `disconnect()` returns, so keep the suppression up for a short tail, then
    // restore. Unref so the timer never keeps a CLI process alive.
    const timer = setTimeout(restore, TEARDOWN_SUPPRESS_TAIL_MS);
    (timer as { unref?: () => void }).unref?.();
}

/** How long the benign-error suppression outlasts `disconnect()`. */
const TEARDOWN_SUPPRESS_TAIL_MS = 50;

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    /**
     * Build a fake LazyClient whose `getSubscribeFn` records each subscribe
     * call and whose returned teardown is observable. Lets tests assert on
     * teardown invocation and on `disconnect` ordering.
     */
    function fakeLazyClient(): {
        client: LazyClient;
        teardownCalls: number;
        disconnectCalls: number;
    } {
        let teardownCalls = 0;
        let disconnectCalls = 0;
        const fake = {
            getClient: (() =>
                ({}) as ReturnType<LazyClient["getClient"]>) as LazyClient["getClient"],
            getRequestFn: (() => () => Promise.resolve()) as LazyClient["getRequestFn"],
            getSubscribeFn: () =>
                ((_method, _params, _onMessage, _onError) => {
                    return () => {
                        teardownCalls += 1;
                    };
                }) as ReturnType<LazyClient["getSubscribeFn"]>,
            disconnect: () => {
                disconnectCalls += 1;
            },
        } as LazyClient;
        return {
            client: fake,
            get teardownCalls() {
                return teardownCalls;
            },
            get disconnectCalls() {
                return disconnectCalls;
            },
        };
    }

    describe("wrapLazyClient", () => {
        test("passes getClient / getRequestFn / disconnect through unchanged", () => {
            const fake = fakeLazyClient();
            const wrapped = wrapLazyClient(fake.client);

            wrapped.getClient();
            wrapped.disconnect();
            expect(fake.disconnectCalls).toBe(1);
            expect(typeof wrapped.getRequestFn).toBe("function");
        });

        test("getSubscribeFn returns a wrapped subscribe whose teardown invokes the inner teardown", () => {
            const fake = fakeLazyClient();
            const wrapped = wrapLazyClient(fake.client);

            const subscribe = wrapped.getSubscribeFn();
            const teardown = subscribe(
                "statement_subscribeStatement",
                [],
                () => {},
                () => {},
            );
            teardown();

            expect(fake.teardownCalls).toBe(1);
        });

        test("awaitPendingUnsubs resolves after all wrapped teardowns settle", async () => {
            const fake = fakeLazyClient();
            const wrapped = wrapLazyClient(fake.client);
            const subscribe = wrapped.getSubscribeFn();

            // Simulate three live subscriptions being torn down in the
            // same tick (what `sessions.dispose()` does internally).
            for (let i = 0; i < 3; i++) {
                const teardown = subscribe(
                    "statement_subscribeStatement",
                    [],
                    () => {},
                    () => {},
                );
                teardown();
            }

            // All three pending — but resolves once microtasks flush.
            await wrapped.awaitPendingUnsubs();
            expect(fake.teardownCalls).toBe(3);
        });

        test("awaitPendingUnsubs with no pending unsubs resolves immediately", async () => {
            const fake = fakeLazyClient();
            const wrapped = wrapLazyClient(fake.client);
            await expect(wrapped.awaitPendingUnsubs()).resolves.toBeUndefined();
        });

        test("an unsubscribe whose teardown throws is still tracked and resolved", async () => {
            // Even if the inner teardown throws, the tracker still needs
            // to settle — otherwise destroy() would hang forever.
            const fake = {
                getClient: (() =>
                    ({}) as ReturnType<LazyClient["getClient"]>) as LazyClient["getClient"],
                getRequestFn: (() => () => Promise.resolve()) as LazyClient["getRequestFn"],
                getSubscribeFn: () =>
                    ((_method, _params, _onMessage, _onError) => {
                        return () => {
                            throw new Error("teardown boom");
                        };
                    }) as ReturnType<LazyClient["getSubscribeFn"]>,
                disconnect: () => {},
            } as LazyClient;

            const wrapped = wrapLazyClient(fake);
            const subscribe = wrapped.getSubscribeFn();
            const teardown = subscribe(
                "statement_subscribeStatement",
                [],
                () => {},
                () => {},
            );

            // The wrapper's inner try/finally lets the throw escape (as
            // expected — we don't swallow user-visible errors), but the
            // tracker still resolves. Catch-and-await pattern:
            try {
                teardown();
            } catch {
                // expected
            }
            await expect(wrapped.awaitPendingUnsubs()).resolves.toBeUndefined();
        });
    });

    describe("teardown", () => {
        test("orders sessions.dispose, drain, then disconnect", async () => {
            const order: string[] = [];

            const fake = fakeLazyClient();
            const wrapped = wrapLazyClient(fake.client);
            // Override disconnect to capture ordering.
            const innerDisconnect = wrapped.disconnect.bind(wrapped);
            wrapped.disconnect = () => {
                order.push("disconnect");
                innerDisconnect();
            };

            const sessions = {
                dispose: vi.fn(() => {
                    order.push("dispose");
                    // Simulate sessions.dispose firing one teardown.
                    const subscribe = wrapped.getSubscribeFn();
                    subscribe(
                        "statement_subscribeStatement",
                        [],
                        () => {},
                        () => {},
                    )();
                }),
            };

            await teardown(sessions, wrapped);

            expect(order).toEqual(["dispose", "disconnect"]);
            expect(sessions.dispose).toHaveBeenCalledTimes(1);
            expect(fake.disconnectCalls).toBe(1);
        });

        test("disconnect runs even when there are no pending unsubs", async () => {
            const fake = fakeLazyClient();
            const wrapped = wrapLazyClient(fake.client);
            const sessions = { dispose: vi.fn() };

            await teardown(sessions, wrapped);

            expect(fake.disconnectCalls).toBe(1);
        });

        test("logs a warning if disconnect throws, doesn't propagate to caller", async () => {
            const fake = {
                getClient: (() =>
                    ({}) as ReturnType<LazyClient["getClient"]>) as LazyClient["getClient"],
                getRequestFn: (() => () => Promise.resolve()) as LazyClient["getRequestFn"],
                getSubscribeFn: () =>
                    ((_method, _params, _onMessage, _onError) => () => {}) as ReturnType<
                        LazyClient["getSubscribeFn"]
                    >,
                disconnect: () => {
                    throw new Error("boom");
                },
            } as LazyClient;

            const wrapped = wrapLazyClient(fake);
            const sessions = { dispose: vi.fn() };

            await expect(teardown(sessions, wrapped)).resolves.toBeUndefined();
        });

        test("awaits pending unsubs before calling disconnect", async () => {
            // The whole point of the fix: disconnect must not run while
            // unsubscribe RPCs are still queued. Verify ordering even
            // when the unsubs take multiple microtasks to settle.
            const fake = fakeLazyClient();
            const wrapped = wrapLazyClient(fake.client);

            let unsubResolved = false;
            const innerDisconnect = wrapped.disconnect.bind(wrapped);
            wrapped.disconnect = () => {
                // Disconnect must not run before the unsubscribe has
                // resolved. If it does, this assertion fires.
                expect(unsubResolved).toBe(true);
                innerDisconnect();
            };

            const sessions = {
                dispose: () => {
                    const subscribe = wrapped.getSubscribeFn();
                    subscribe(
                        "statement_subscribeStatement",
                        [],
                        () => {},
                        () => {},
                    )();
                    // mark resolution after the microtasks the wrapper queues
                    queueMicrotask(() =>
                        queueMicrotask(() => {
                            unsubResolved = true;
                        }),
                    );
                },
            };

            await teardown(sessions, wrapped);
            expect(fake.disconnectCalls).toBe(1);
        });

        test("suppresses the benign DestroyedError console.error fired during disconnect", async () => {
            // The upstream statement-store adapter logs `Statement subscription
            // error: DestroyedError` from a finalizer when disconnect destroys
            // the client under a live subscription. Simulate that by logging it
            // from inside disconnect; teardown must swallow it.
            const spy = vi.spyOn(console, "error").mockImplementation(() => {});
            const fake = {
                getClient: (() =>
                    ({}) as ReturnType<LazyClient["getClient"]>) as LazyClient["getClient"],
                getRequestFn: (() => () => Promise.resolve()) as LazyClient["getRequestFn"],
                getSubscribeFn: () =>
                    ((_m, _p, _om, _oe) => () => {}) as ReturnType<LazyClient["getSubscribeFn"]>,
                disconnect: () => {
                    console.error(
                        "Statement subscription error:",
                        new Error("DestroyedError: Client destroyed"),
                    );
                },
            } as LazyClient;
            const wrapped = wrapLazyClient(fake);

            await teardown({ dispose: () => {} }, wrapped);

            // The benign line never reached the underlying console.error.
            expect(spy).not.toHaveBeenCalledWith(
                "Statement subscription error:",
                expect.anything(),
            );
            spy.mockRestore();
        });

        test("still surfaces a real (non-benign) console.error during disconnect", async () => {
            const spy = vi.spyOn(console, "error").mockImplementation(() => {});
            const realError = new Error("something actually went wrong");
            const fake = {
                getClient: (() =>
                    ({}) as ReturnType<LazyClient["getClient"]>) as LazyClient["getClient"],
                getRequestFn: (() => () => Promise.resolve()) as LazyClient["getRequestFn"],
                getSubscribeFn: () =>
                    ((_m, _p, _om, _oe) => () => {}) as ReturnType<LazyClient["getSubscribeFn"]>,
                disconnect: () => {
                    console.error("real failure:", realError);
                },
            } as LazyClient;
            const wrapped = wrapLazyClient(fake);

            await teardown({ dispose: () => {} }, wrapped);

            expect(spy).toHaveBeenCalledWith("real failure:", realError);
            spy.mockRestore();
        });

        test("restores console.error after teardown", async () => {
            const before = console.error;
            const fake = fakeLazyClient();
            const wrapped = wrapLazyClient(fake.client);

            await teardown({ dispose: () => {} }, wrapped);
            // The tail timer restores on the next macrotask; wait past it.
            await new Promise((r) => setTimeout(r, TEARDOWN_SUPPRESS_TAIL_MS + 10));

            expect(console.error).toBe(before);
        });
    });

    describe("isBenignTeardownError", () => {
        test("matches the statement-store teardown noise", () => {
            expect(isBenignTeardownError(new Error("DestroyedError: Client destroyed"))).toBe(true);
            expect(isBenignTeardownError("Client destroyed")).toBe(true);
            const e = new Error("Client destroyed");
            e.name = "DestroyedError";
            expect(isBenignTeardownError(e)).toBe(true);
        });

        test("does not match a genuine error", () => {
            expect(isBenignTeardownError(new Error("connection refused"))).toBe(false);
            expect(isBenignTeardownError("BadProof")).toBe(false);
            expect(isBenignTeardownError(undefined)).toBe(false);
        });
    });
}

export { SS_STABLE_STAGE_ENDPOINTS, SS_PASEO_STABLE_STAGE_ENDPOINTS };
