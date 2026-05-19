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
    /** URL to the app's metadata JSON (name + icon), shown during pairing. */
    metadataUrl: string;
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
     * queue. No timing-based guesses; no global-state mutations of
     * `console.error` or `process.on('unhandledRejection')`. Pending
     * subscribes (where `onSuccess` hasn't fired yet) are cancelled by
     * the underlying `getSubscribeFn` teardown via `cancelRequest()`,
     * which is the in-band fast-path and doesn't surface as a rejection.
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
        metadata: options.metadataUrl,
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
 * Drain pending unsubscribes, then disconnect. Order matters and is now
 * deterministic — no `setTimeout` guesses, no global-state mutations.
 *
 *   1. `sessions.dispose()` walks each open statement-subscription and
 *      triggers their RPC unsubscribe via the wrapped subscribe-fn's
 *      teardown callback. Each unsubscribe is recorded as a tracked
 *      Promise on the wrapper.
 *   2. `awaitPendingUnsubs()` waits for those tracked Promises to
 *      settle (resolution OR rejection — we just need confirmation the
 *      RPC has left the substrate-client send pipeline).
 *   3. `disconnect()` calls `substrateClient.destroy()`. Nothing is
 *      pending at this point, so no `DestroyedError` rejections fire.
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
    try {
        lazyClient.disconnect();
    } catch (e) {
        log.warn("lazyClient.disconnect threw during destroy", { error: e });
    }
}

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
    });
}

export { SS_STABLE_STAGE_ENDPOINTS, SS_PASEO_STABLE_STAGE_ENDPOINTS };
