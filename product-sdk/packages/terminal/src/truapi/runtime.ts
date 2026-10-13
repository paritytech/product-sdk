// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * truapi backend runtime: embeds `@parity/truapi-host`'s WASM pairing host in
 * Node and exposes a `@parity/truapi` client scoped to the terminal's product.
 *
 * This replaces `@novasamatech/host-papp` + `@novasamatech/statement-store`:
 * the Rust core owns SSO pairing, the session, statement-store allowances and
 * signing requests; the terminal supplies storage, chain connections and the
 * pairing QR.
 *
 * Experimental and opt-in (`@parity/product-sdk-terminal/truapi`). Sessions are
 * not shared with the host-papp backend: switching backends means pairing once
 * more. Product account addresses are unchanged, since both backends derive
 * them from the same wallet subtree key.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLogger } from "@parity/product-sdk-logger";
import {
    createClient,
    createMessagePortProvider,
    createTransport,
    type TrUApiClient,
} from "@parity/truapi";
import type { AuthState, SessionUiInfo } from "@parity/truapi-host";
import { createMockHost } from "@parity/truapi-host/testing";

import { sanitizeKey } from "../node-storage.js";
import { openJsonRpcConnection, type JsonRpcConnection } from "./chain.js";
import { TruapiNetworks, type TruapiNetwork, type TruapiNetworkName } from "./networks.js";
import { createFileCoreStorage } from "./storage.js";

const log = createLogger("terminal:truapi");

/** Pairing on Paseo takes 80-110 s end to end; the client default is 120 s. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export interface TruapiTerminalOptions {
    /** Product id (dotNS name, e.g. `"my-cli.dot"`). Scopes accounts and storage. */
    appId: string;
    /** Chain set to pair on. Defaults to `"paseo-next-v2"`. */
    network?: TruapiNetworkName | TruapiNetwork;
    /**
     * Directory for the core's persisted state. Defaults to
     * `~/.polkadot-apps/truapi/<appId>`, separate from host-papp sessions.
     */
    storageDir?: string;
    /** Shown to the wallet during pairing. */
    hostMetadata?: { name?: string; version?: string; icon?: string };
    /** Per-request timeout for client calls. Defaults to 300 s. */
    requestTimeoutMs?: number;
}

export interface LoginOptions {
    /** Shown by the wallet. */
    reason?: string;
    /** Called with the `polkadotapp://pair?...` deeplink to render as a QR. */
    onPairing?(deeplink: string): void;
}

export interface TruapiTerminal {
    readonly appId: string;
    readonly storageDir: string;
    /** The product-scoped truapi client: account, signing, entropy, statementStore, ... */
    readonly client: TrUApiClient;
    /** Latest auth state the core reported. */
    readonly authState: AuthState;
    /** Subscribe to auth state changes. Returns an unsubscribe function. */
    onAuthStateChange(listener: (state: AuthState) => void): () => void;
    /**
     * Resolve with the active session, pairing first if there is none. Rejects
     * when the wallet refuses or the login fails.
     */
    login(options?: LoginOptions): Promise<SessionUiInfo>;
    /** Disconnect the session, notifying the wallet when possible. */
    logout(): Promise<void>;
    /** The product's hard-subtree public key, for local product-account derivation. */
    productSubtreePublicKey(productId?: string, timeoutMs?: number): Promise<Uint8Array>;
    /** Stop the runtime and close chain connections. Idempotent. */
    destroy(): Promise<void>;
}

// --- truapi-host internals ----------------------------------------------------
// The package ships a wasm-bindgen `web` build and its callback adapter without
// a Node entry point or an exports-map entry, so they are loaded by path.

interface WasmProductRuntime {
    receiveFrame(frame: Uint8Array): Promise<void>;
    dispose(): void;
}
interface WasmPairingHostRuntime {
    activateStoredSession(): Promise<void>;
    disconnectSession(): Promise<void>;
    productRuntime(
        product: { productId: string },
        callbacks: { emitFrame(frame: Uint8Array): void },
    ): WasmProductRuntime;
    productSubtreePublicKey(
        productId: string,
        timeoutMs?: number | null,
    ): Promise<Uint8Array | undefined>;
    free(): void;
}
interface WasmGlue {
    initSync(options: { module: Uint8Array }): unknown;
    WasmPairingHostRuntime: new (callbacks: unknown, hostConfig: unknown) => WasmPairingHostRuntime;
}

function truapiHostDir(): string {
    if (typeof import.meta.resolve === "function") {
        // dist/index.js -> package root
        return dirname(dirname(fileURLToPath(import.meta.resolve("@parity/truapi-host"))));
    }
    // Runners without import.meta.resolve (vitest): the exports map only gives
    // `./testing/server` a require condition. dist/testing/server.cjs -> root.
    const entry = createRequire(import.meta.url).resolve("@parity/truapi-host/testing/server");
    return dirname(dirname(dirname(entry)));
}

let fetchShimInstalled = false;
/**
 * The ring-VRF module inside the WASM build loads its own `.wasm` with
 * `fetch(new URL(..., import.meta.url))`, a `file:` URL under Node, which
 * Node's fetch rejects. Serve only those files from disk; every other request
 * goes to the real fetch.
 */
function installFileFetchShim(root: string): void {
    if (fetchShimInstalled) return;
    fetchShimInstalled = true;
    const rootUrl = pathToFileURL(root).href;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const href =
            input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        if (href.startsWith(rootUrl)) {
            return new Response(readFileSync(fileURLToPath(href)), {
                headers: { "content-type": "application/wasm" },
            });
        }
        return realFetch(input, init);
    }) as typeof fetch;
}

let gluePromise:
    | Promise<{ glue: WasmGlue; createWasmRawCallbacks: (cb: unknown) => object }>
    | undefined;
function loadTruapiHost() {
    gluePromise ??= (async () => {
        const root = truapiHostDir();
        const wasmDir = join(root, "dist/wasm/web");
        installFileFetchShim(join(root, "dist/wasm"));
        const glue = (await import(
            pathToFileURL(join(wasmDir, "truapi_server.js")).href
        )) as WasmGlue;
        glue.initSync({ module: readFileSync(join(wasmDir, "truapi_server_bg.wasm")) });
        const adapter = (await import(
            pathToFileURL(join(root, "dist/generated/host-callbacks-adapter.js")).href
        )) as { createWasmRawCallbacks: (cb: unknown) => object };
        return { glue, createWasmRawCallbacks: adapter.createWasmRawCallbacks };
    })();
    return gluePromise;
}

// --- Runtime ------------------------------------------------------------------

export function defaultTruapiStorageDir(appId: string): string {
    return join(homedir(), ".polkadot-apps", "truapi", sanitizeKey(appId, "core"));
}

function resolveNetwork(network: TruapiTerminalOptions["network"]): TruapiNetwork {
    if (!network) return TruapiNetworks["paseo-next-v2"];
    if (typeof network === "string") {
        const preset = TruapiNetworks[network];
        if (!preset) throw new Error(`Unknown truapi network "${network}"`);
        return preset;
    }
    return network;
}

export async function createTruapiTerminal(
    options: TruapiTerminalOptions,
): Promise<TruapiTerminal> {
    const network = resolveNetwork(options.network);
    const storageDir = options.storageDir ?? defaultTruapiStorageDir(options.appId);
    const { glue, createWasmRawCallbacks } = await loadTruapiHost();

    const chains = [
        ["People", network.people],
        ["Bulletin", network.bulletin],
        ["AssetHub", network.assetHub],
    ] as const;
    const endpointByGenesis = new Map(
        chains.map(([, c]) => [c.genesisHash.toLowerCase(), c.endpoint]),
    );
    const openConnections = new Set<JsonRpcConnection>();

    // Start from truapi-host's mock host so every capability the core requires
    // has an implementation, then own the ones a terminal host is responsible
    // for. TODO(truapi-host): replace with a documented minimal callback set.
    const host = createMockHost({
        supportedChains: {
            network: network.name,
            chains: chains.map(([identifier, c]) => ({ identifier, genesisHash: c.genesisHash })),
        },
    });
    const callbacks = host.callbacks;
    callbacks.coreStorage = createFileCoreStorage(storageDir);
    callbacks.chain = {
        async connect(genesisHash: Uint8Array) {
            const hex = `0x${Buffer.from(genesisHash).toString("hex")}`;
            const endpoint = endpointByGenesis.get(hex);
            if (!endpoint) throw new Error(`truapi: no endpoint for genesis ${hex}`);
            const conn = openJsonRpcConnection(endpoint);
            openConnections.add(conn);
            return {
                ...conn,
                close() {
                    openConnections.delete(conn);
                    conn.close();
                },
            };
        },
    } as typeof callbacks.chain;

    let authState: AuthState = { tag: "Disconnected" };
    const listeners = new Set<(state: AuthState) => void>();
    callbacks.auth = {
        authStateChanged(state: AuthState) {
            authState = state;
            log.debug("auth state", { tag: state.tag });
            for (const l of listeners) l(state);
        },
    };

    const runtime = new glue.WasmPairingHostRuntime(
        { ...createWasmRawCallbacks(callbacks), workerDemandChanged: () => {} },
        {
            host: {
                name: options.hostMetadata?.name ?? options.appId,
                version: options.hostMetadata?.version,
                icon: options.hostMetadata?.icon,
                platform: "Cli",
            },
            platform: { type: process.platform, version: process.version },
            people: { genesisHash: network.people.genesisHash },
            bulletin: { genesisHash: network.bulletin.genesisHash },
            assetHub: { genesisHash: network.assetHub.genesisHash },
            pairing: { deeplinkScheme: "polkadotapp" },
        },
    );
    await runtime.activateStoredSession().catch((e: unknown) => {
        log.debug("no stored session restored", { reason: String(e) });
    });

    const channel = new MessageChannel();
    const core = runtime.productRuntime(
        { productId: options.appId },
        { emitFrame: (frame) => channel.port1.postMessage(frame) },
    );
    channel.port1.onmessage = (event: MessageEvent) => {
        if (event.data instanceof Uint8Array) void core.receiveFrame(event.data);
    };
    channel.port1.start();
    const provider = createMessagePortProvider(channel.port2);
    const client = createClient(
        createTransport(provider, {
            requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        }),
    );

    const onAuthStateChange = (listener: (state: AuthState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };

    let destroyed: Promise<void> | undefined;
    return {
        appId: options.appId,
        storageDir,
        client,
        get authState() {
            return authState;
        },
        onAuthStateChange,

        login(loginOptions = {}) {
            if (authState.tag === "Connected") return Promise.resolve(authState.value);
            return new Promise<SessionUiInfo>((resolve, reject) => {
                const stop = onAuthStateChange((state) => {
                    if (state.tag === "Pairing") loginOptions.onPairing?.(state.value.deeplink);
                    else if (state.tag === "Connected") {
                        stop();
                        resolve(state.value);
                    } else if (state.tag === "LoginFailed") {
                        stop();
                        reject(
                            new Error(`Login failed (${state.value.kind}): ${state.value.reason}`),
                        );
                    }
                });
                client.account.requestLogin({ reason: loginOptions.reason }).match(
                    (response) => {
                        if (response === "Rejected") {
                            stop();
                            reject(new Error("Login rejected by the wallet"));
                        } else if (
                            response === "AlreadyConnected" &&
                            authState.tag === "Connected"
                        ) {
                            stop();
                            resolve(authState.value);
                        }
                    },
                    (error) => {
                        stop();
                        reject(new Error(`Login request failed: ${JSON.stringify(error)}`));
                    },
                );
            });
        },

        async logout() {
            await runtime.disconnectSession();
        },

        async productSubtreePublicKey(productId = options.appId, timeoutMs = 120_000) {
            const key = await runtime.productSubtreePublicKey(productId, timeoutMs);
            if (!key) throw new Error("No active session: call login() first");
            return key;
        },

        destroy() {
            destroyed ??= (async () => {
                provider.dispose();
                core.dispose();
                channel.port1.close();
                channel.port2.close();
                for (const conn of openConnections) conn.close();
                openConnections.clear();
                runtime.free();
            })();
            return destroyed;
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("defaultTruapiStorageDir", () => {
        test("is per app and separate from host-papp session files", () => {
            const dir = defaultTruapiStorageDir("my-cli.dot");
            expect(dir).toContain(join(".polkadot-apps", "truapi"));
            expect(dir).not.toBe(defaultTruapiStorageDir("other.dot"));
        });
    });

    describe("resolveNetwork", () => {
        test("defaults to paseo-next-v2", () => {
            expect(resolveNetwork(undefined)).toBe(TruapiNetworks["paseo-next-v2"]);
        });
        test("rejects unknown preset names", () => {
            expect(() => resolveNetwork("nope" as TruapiNetworkName)).toThrow(
                /Unknown truapi network/,
            );
        });
    });

    describe("createTruapiTerminal (offline)", () => {
        test("boots the WASM pairing host in Node and reports Disconnected with no stored session", async () => {
            const { mkdtemp, rm } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const storageDir = await mkdtemp(join(tmpdir(), "terminal-truapi-boot-"));
            try {
                const t = await createTruapiTerminal({ appId: "terminal-test.dot", storageDir });
                expect(t.authState.tag).toBe("Disconnected");
                await expect(t.productSubtreePublicKey()).rejects.toThrow(/No active session/);
                await t.destroy();
                await t.destroy();
            } finally {
                await rm(storageDir, { recursive: true, force: true });
            }
        });
    });
}
