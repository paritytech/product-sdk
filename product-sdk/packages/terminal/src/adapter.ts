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
     * Idempotent. While this method is running and for ~50 ms after, the global
     * `console.error` is monkey-patched to suppress the noisy
     * `"Statement subscription error: …"` message that
     * `@novasamatech/statement-store` emits when its WebSocket disconnects with
     * live subscriptions still attached. Unrelated `console.error` calls in
     * that window may be silently swallowed if their first argument is a string
     * starting with `"Statement subscription"`. This is a pragmatic workaround
     * for the upstream noise; ideally we contribute a `silent` option upstream.
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
            log.debug("destroying terminal adapter; suppressing statement-store teardown noise");

            // The statement-store logs `console.error("Statement subscription error:", err)`
            // when the WebSocket disconnects while subscriptions are still active.
            // This is expected during teardown. Temporarily mute it.
            const origError = console.error;
            console.error = (...args: unknown[]) => {
                if (typeof args[0] === "string" && args[0].includes("Statement subscription")) {
                    return;
                }
                origError.apply(console, args);
            };

            adapter.sessions.dispose();
            try {
                lazyClient.disconnect();
            } catch (e) {
                log.warn("lazyClient.disconnect threw during destroy", { error: e });
            }

            setTimeout(() => {
                console.error = origError;
            }, 50);
        },
    };
}

export { SS_STABLE_STAGE_ENDPOINTS, SS_PASEO_STABLE_STAGE_ENDPOINTS };
