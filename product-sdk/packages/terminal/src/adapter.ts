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
import { createLazyClient, createPapiStatementStoreAdapter } from "@novasamatech/statement-store";
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
     * Disconnect the WebSocket and release resources.
     *
     * @remarks
     * Idempotent. Returns synchronously, but the underlying transport is
     * actually torn down on the next event-loop turn so in-flight unsubscribe
     * RPCs from `sessions.dispose()` have a chance to leave before the
     * substrate-client request queue is destroyed. For ~100 ms after this
     * method returns, two process globals are temporarily intercepted:
     *
     * - `console.error` ignores any first-arg string starting with
     *   `"Statement subscription"` (the noisy log
     *   `@novasamatech/statement-store` emits when its WebSocket disconnects
     *   with live subscriptions still attached). Unrelated console.error
     *   calls passing through that filter still go through.
     * - `process.on('unhandledRejection')` ignores any rejection whose
     *   `name === "DestroyedError"` or whose message includes
     *   `"Client destroyed"`. Other unhandled rejections are re-thrown
     *   asynchronously so default handlers still see them.
     *
     * Both interceptors are best-effort workarounds for upstream teardown
     * behavior — ideally we contribute a `silent` option upstream.
     */
    destroy(): void;
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
    const lazyClient = createLazyClient(
        getWsProvider(endpoints, { heartbeatTimeout: HEARTBEAT_NEVER_MS }),
    );
    const statementStore = createPapiStatementStoreAdapter(lazyClient);

    const adapter = createPappAdapter({
        appId: options.appId,
        metadata: options.metadataUrl,
        hostMetadata: options.hostMetadata,
        adapters: {
            storage,
            lazyClient,
            statementStore,
        },
    });

    let destroyed = false;
    return {
        ...adapter,
        appId: options.appId,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            log.debug("destroying terminal adapter");
            performTeardown(adapter.sessions, lazyClient);
        },
    };
}

/**
 * Run the destroy sequence with all three of: console.error suppression,
 * deferred disconnect, and DestroyedError unhandled-rejection guard.
 *
 * Extracted so the in-source vitest block can drive it directly with stub
 * adapters.
 *
 * Teardown sequence here is order-sensitive:
 *
 *   1. `sessions.dispose()` walks each open statement-subscription and
 *      triggers their RPC unsubscribe (`statement_unsubscribe…`) via
 *      `lazyClient.getSubscribeFn`'s teardown callback. Those RPC calls
 *      are fire-and-forget but they need a turn of the event loop to
 *      actually leave the substrate-client request queue.
 *   2. `lazyClient.disconnect()` calls `substrateClient.destroy()`, which
 *      synchronously rejects every still-pending request with
 *      `DestroyedError("Client destroyed")`. If we run this in the same
 *      tick as step 1, the unsubscribes never get to send and any
 *      in-flight subscribes reject — those rejections hit consumer error
 *      handlers as `Statement subscription error: …` console.error logs
 *      AND surface as unhandled promise rejections.
 *
 * Mitigations (each has caveats; we do all three):
 *
 *   A) Suppress the `Statement subscription error: …` console.error log
 *      so it doesn't pollute consumer output. Process-global monkey-patch
 *      — narrowly scoped (string-prefix match) and bounded (~100ms after
 *      destroy returns).
 *   B) Defer `lazyClient.disconnect()` to the next macrotask via
 *      `setTimeout(0)`. Gives the unsubscribe RPCs from step 1 a chance
 *      to leave before the request queue is destroyed.
 *   C) Install a `process.on('unhandledRejection')` handler that swallows
 *      `DestroyedError` rejections during the teardown window. Anything
 *      else propagates as normal. By the time destroy() runs, any
 *      pending request whose only consumer was the now-disposed session
 *      is, by definition, no longer wanted — letting its rejection take
 *      down the process is wrong.
 */
function performTeardown(sessions: { dispose(): void }, lazyClient: { disconnect(): void }): void {
    const origError = console.error;
    console.error = (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].includes("Statement subscription")) {
            return;
        }
        origError.apply(console, args);
    };

    const unhandledHandler = (reason: unknown) => {
        if (isDestroyedError(reason)) {
            return; // suppress — see (C) above
        }
        // Re-throw asynchronously so other handlers (default Node, vitest,
        // user's own) still see the rejection.
        queueMicrotask(() => {
            throw reason;
        });
    };
    if (typeof process !== "undefined" && typeof process.on === "function") {
        process.on("unhandledRejection", unhandledHandler);
    }

    // Step 1: synchronous — fires unsubscribe RPCs into the queue.
    sessions.dispose();

    // Step 2: deferred — let the unsubscribe RPCs leave before destroying
    // the request queue.
    setTimeout(() => {
        try {
            lazyClient.disconnect();
        } catch (e) {
            log.warn("lazyClient.disconnect threw during destroy", { error: e });
        }
    }, 0);

    // Restore globals after a window long enough to cover both
    // (a) the deferred disconnect actually firing and (b) any
    // immediate rejections it triggers.
    setTimeout(() => {
        console.error = origError;
        if (typeof process !== "undefined" && typeof process.off === "function") {
            process.off("unhandledRejection", unhandledHandler);
        }
    }, 100);
}

function isDestroyedError(reason: unknown): boolean {
    if (!reason || typeof reason !== "object") return false;
    const r = reason as { name?: unknown; message?: unknown };
    if (r.name === "DestroyedError") return true;
    if (typeof r.message === "string" && r.message.includes("Client destroyed")) return true;
    return false;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi, beforeEach, afterEach } = import.meta.vitest;

    describe("isDestroyedError", () => {
        test("matches an Error instance whose name is DestroyedError", () => {
            const e = new Error("Client destroyed");
            e.name = "DestroyedError";
            expect(isDestroyedError(e)).toBe(true);
        });

        test("matches an error whose message includes 'Client destroyed' even with default name", () => {
            expect(isDestroyedError(new Error("Client destroyed"))).toBe(true);
        });

        test("does not match unrelated errors", () => {
            expect(isDestroyedError(new Error("network down"))).toBe(false);
            expect(isDestroyedError(new TypeError("oops"))).toBe(false);
        });

        test("does not match non-error values", () => {
            expect(isDestroyedError(undefined)).toBe(false);
            expect(isDestroyedError(null)).toBe(false);
            expect(isDestroyedError("Client destroyed")).toBe(false);
            expect(isDestroyedError(42)).toBe(false);
        });
    });

    describe("performTeardown", () => {
        let origConsoleError: typeof console.error;
        let unhandledListenersBefore: number;

        beforeEach(() => {
            origConsoleError = console.error;
            unhandledListenersBefore = process.listenerCount("unhandledRejection");
            vi.useFakeTimers();
        });

        afterEach(() => {
            // Always advance to clear any pending timers from the SUT.
            vi.runAllTimers();
            vi.useRealTimers();
            // Restore in case a test leaked.
            console.error = origConsoleError;
            // Strip any leftover handlers the SUT didn't get to clean up.
            const after = process.listeners("unhandledRejection");
            for (let i = unhandledListenersBefore; i < after.length; i++) {
                process.off("unhandledRejection", after[i]);
            }
        });

        test("calls sessions.dispose synchronously", () => {
            const sessions = { dispose: vi.fn() };
            const lazyClient = { disconnect: vi.fn() };

            performTeardown(sessions, lazyClient);

            expect(sessions.dispose).toHaveBeenCalledTimes(1);
        });

        test("defers lazyClient.disconnect to a later tick (so unsubscribes can drain)", () => {
            const sessions = { dispose: vi.fn() };
            const lazyClient = { disconnect: vi.fn() };

            performTeardown(sessions, lazyClient);

            // Disconnect must NOT happen in the same tick as dispose.
            expect(lazyClient.disconnect).not.toHaveBeenCalled();

            // After the queued setTimeout(0) fires, disconnect runs.
            vi.advanceTimersByTime(0);
            expect(lazyClient.disconnect).toHaveBeenCalledTimes(1);
        });

        test("suppresses 'Statement subscription' console.error during the teardown window", () => {
            const sessions = { dispose: vi.fn() };
            const lazyClient = { disconnect: vi.fn() };
            const writes: unknown[][] = [];
            console.error = (...args: unknown[]) => {
                writes.push(args);
            };

            performTeardown(sessions, lazyClient);

            // Simulate the upstream noise:
            console.error("Statement subscription error:", new Error("Client destroyed"));
            expect(writes).toHaveLength(0); // suppressed

            // Unrelated console.error still passes through:
            console.error("something completely different");
            expect(writes).toHaveLength(1);
            expect(writes[0]).toEqual(["something completely different"]);
        });

        test("restores console.error after the teardown window", () => {
            const sessions = { dispose: vi.fn() };
            const lazyClient = { disconnect: vi.fn() };
            const sentinel = vi.fn();
            console.error = sentinel;

            performTeardown(sessions, lazyClient);
            // During the window: not the sentinel.
            expect(console.error).not.toBe(sentinel);

            // Past the window: restored.
            vi.advanceTimersByTime(100);
            expect(console.error).toBe(sentinel);
        });

        test("registers and removes the unhandledRejection handler symmetrically", () => {
            const sessions = { dispose: vi.fn() };
            const lazyClient = { disconnect: vi.fn() };
            const before = process.listenerCount("unhandledRejection");

            performTeardown(sessions, lazyClient);
            expect(process.listenerCount("unhandledRejection")).toBe(before + 1);

            vi.advanceTimersByTime(100);
            expect(process.listenerCount("unhandledRejection")).toBe(before);
        });

        test("logs a warning if lazyClient.disconnect throws (doesn't propagate)", () => {
            const sessions = { dispose: vi.fn() };
            const lazyClient = {
                disconnect: vi.fn(() => {
                    throw new Error("boom");
                }),
            };

            expect(() => {
                performTeardown(sessions, lazyClient);
                vi.advanceTimersByTime(0);
            }).not.toThrow();
        });

        test("the unhandledRejection handler swallows DestroyedError", () => {
            const sessions = { dispose: vi.fn() };
            const lazyClient = { disconnect: vi.fn() };

            performTeardown(sessions, lazyClient);
            const handler = process.listeners("unhandledRejection").at(-1) as
                | ((reason: unknown) => void)
                | undefined;

            // Simulate a DestroyedError surfacing — handler should swallow it.
            const destroyed = new Error("Client destroyed");
            destroyed.name = "DestroyedError";
            // Our installed handler returns silently for DestroyedError; the
            // act of NOT throwing or re-queueing is the contract.
            expect(() => handler?.(destroyed)).not.toThrow();
        });
    });
}

export { SS_STABLE_STAGE_ENDPOINTS, SS_PASEO_STABLE_STAGE_ENDPOINTS };
