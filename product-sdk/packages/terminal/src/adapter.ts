// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal's pairing host: the truapi Rust core every other host runs,
 * started in a Node worker thread through `@parity/truapi-host/node`.
 *
 * The core owns pairing with the user's wallet, the session, allowances and
 * signing requests. The terminal supplies what only it can: files on disk,
 * chain connections, the pairing QR and the answers to the core's reviews.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { createLogger } from "@parity/product-sdk-logger";
import { createClient, createTransport, type TrUApiClient } from "@parity/truapi";
import type { AuthState, SessionUiInfo } from "@parity/truapi-host";
import {
    createHeadlessHostCallbacks,
    createNodePairingHostRuntime,
    type WorkerPairingHostRuntime,
} from "@parity/truapi-host/node";

import { describeCallError } from "./call-error.js";
import {
    approveAll,
    createApprovalCallbacks,
    type TerminalApprovals,
} from "./host-callbacks/approvals.js";
import { createChainProvider } from "./host-callbacks/chain.js";
import { createFileCoreStorage, createFileProductStorage } from "./host-callbacks/storage.js";
import { resolveNetwork, type TerminalNetwork, type TerminalNetworkName } from "./networks.js";

const log = createLogger("terminal");

/** Pairing takes 80 to 110 s on Paseo, longer than the client's 120 s default leaves for slow phones. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** The paired wallet session: its root key, identity and usernames. */
export type TerminalSession = SessionUiInfo;

export interface TerminalAdapterOptions {
    /**
     * The product this CLI acts as: a dotNS id ending in `.dot`, `.paseo` or
     * `.testnet`, e.g. `"my-cli.dot"`, or `localhost`. Scopes accounts and storage.
     */
    appId: string;
    /** Chains to pair and sign over. Defaults to `"paseo-next-v2"`. */
    network?: TerminalNetworkName | TerminalNetwork;
    /**
     * This app's own directory, holding the session (`core/`) and the product's
     * storage (`product/`). Defaults to `~/.polkadot-apps/<appId>`.
     */
    storageDir?: string;
    /** Shown on the phone while pairing. */
    hostMetadata?: { name?: string; version?: string; icon?: string };
    /** Answers the core's reviews and permission requests. Defaults to approving them. */
    approvals?: TerminalApprovals;
    /** Per-request timeout for product calls. Defaults to 300 s. */
    requestTimeoutMs?: number;
    /** The core's log level: `off` (default), `error`, `warn`, `info`, `debug` or `trace`. */
    logLevel?: string;
}

export interface LoginOptions {
    /** Shown by the wallet. */
    reason?: string;
    /** Called with the `polkadotapp://pair?…` link to show as a QR code. */
    onPairing?(deeplink: string): void;
}

export interface TerminalAdapter {
    readonly appId: string;
    readonly storageDir: string;
    /** The pairing host runtime, for anything this adapter does not wrap. */
    readonly runtime: WorkerPairingHostRuntime;
    /** The paired session, or `undefined` while there is none. */
    readonly session: TerminalSession | undefined;
    readonly authState: AuthState;
    /** Called on every auth state change. Returns an unsubscribe function. */
    onAuthStateChange(listener: (state: AuthState) => void): () => void;
    /** A truapi client acting as `productId`, by default the adapter's `appId`. */
    client(productId?: string): Promise<TrUApiClient>;
    /** Resolve with the session, pairing first when there is none. */
    login(options?: LoginOptions): Promise<TerminalSession>;
    /** End the session and tell the paired wallet when it can be reached. */
    logout(): Promise<void>;
    /** Stop the core's thread. Idempotent. */
    destroy(): Promise<void>;
}

export function defaultStorageDir(appId: string): string {
    return join(homedir(), ".polkadot-apps", appId.replace(/[^a-zA-Z0-9_.-]/g, "_"));
}

export async function createTerminalAdapter(
    options: TerminalAdapterOptions,
): Promise<TerminalAdapter> {
    const network = resolveNetwork(options.network);
    const storageDir = options.storageDir ?? defaultStorageDir(options.appId);
    const chains = {
        People: network.people,
        Bulletin: network.bulletin,
        AssetHub: network.assetHub,
    };

    let authState: AuthState = { tag: "Disconnected" };
    const listeners = new Set<(state: AuthState) => void>();
    const onAuthStateChange = (listener: (state: AuthState) => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };

    const runtime = await createNodePairingHostRuntime(
        createHeadlessHostCallbacks({
            coreStorage: createFileCoreStorage(storageDir),
            productStorage: createFileProductStorage(storageDir),
            chain: createChainProvider(
                new Map(Object.values(chains).map((chain) => [chain.genesisHash, chain.endpoint])),
            ),
            auth: {
                authStateChanged(state) {
                    authState = state;
                    for (const listener of listeners) {
                        try {
                            listener(state);
                        } catch (cause) {
                            log.warn("auth state listener threw", { cause });
                        }
                    }
                },
            },
            supportedChains: {
                network: network.name,
                chains: Object.entries(chains).map(([identifier, chain]) => ({
                    identifier: identifier as "People" | "Bulletin" | "AssetHub",
                    genesisHash: chain.genesisHash,
                })),
            },
            ...createApprovalCallbacks(options.approvals ?? approveAll),
        }),
        {
            hostConfig: {
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
            logLevel: options.logLevel,
        },
    );
    await runtime.activateStoredSession().catch((cause: unknown) => {
        // No stored session is the normal first run; an unreadable or invalid
        // one is worth seeing, since the user is about to pair over it.
        if (String(cause).includes("stored auth session is absent")) log.debug("no stored session");
        else log.warn("could not restore the stored session", { cause });
    });

    const clients = new Map<string, Promise<TrUApiClient>>();
    const client = (productId = options.appId) => {
        let created = clients.get(productId);
        if (!created) {
            created = runtime.createProvider({ productId }).then((provider) =>
                createClient(
                    createTransport(provider, {
                        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
                    }),
                ),
            );
            clients.set(productId, created);
            // A failed creation is not kept, so the next call tries again.
            created.catch(() => clients.delete(productId));
        }
        return created;
    };

    let destroyed: Promise<void> | undefined;
    return {
        appId: options.appId,
        storageDir,
        runtime,
        get session() {
            return authState.tag === "Connected" ? authState.value : undefined;
        },
        get authState() {
            return authState;
        },
        onAuthStateChange,
        client,

        async login(loginOptions = {}) {
            if (authState.tag === "Connected") return authState.value;
            const productClient = await client();
            return new Promise<TerminalSession>((resolve, reject) => {
                const stop = onAuthStateChange((state) => {
                    if (state.tag === "Pairing") loginOptions.onPairing?.(state.value.deeplink);
                    if (state.tag === "Connected") {
                        stop();
                        resolve(state.value);
                    }
                    if (state.tag === "LoginFailed") {
                        stop();
                        reject(new Error(`Login failed: ${state.value.reason}`));
                    }
                });
                const fail = (error: Error) => {
                    stop();
                    reject(error);
                };
                productClient.account
                    .requestLogin({ reason: loginOptions.reason })
                    .match(
                        (response) => {
                            if (response === "Rejected") fail(new Error("Login was rejected"));
                            // Connected while the client was being created, before the listener ran.
                            else if (authState.tag === "Connected") {
                                stop();
                                resolve(authState.value);
                            }
                        },
                        (error) =>
                            fail(new Error(`Login request failed: ${describeCallError(error)}`)),
                    )
                    .catch((error: unknown) =>
                        fail(error instanceof Error ? error : new Error(String(error))),
                    );
            });
        },

        logout: () => runtime.disconnectSession(),

        destroy() {
            destroyed ??= Promise.resolve().then(() => runtime.dispose());
            return destroyed;
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { mkdtemp, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { TerminalNetworks } = await import("./networks.js");

    // Real core, no network: every chain endpoint is a closed local port.
    const offline: TerminalNetwork = {
        ...TerminalNetworks["paseo-next-v2"],
        people: { ...TerminalNetworks["paseo-next-v2"].people, endpoint: "ws://127.0.0.1:9" },
        bulletin: { ...TerminalNetworks["paseo-next-v2"].bulletin, endpoint: "ws://127.0.0.1:9" },
        assetHub: { ...TerminalNetworks["paseo-next-v2"].assetHub, endpoint: "ws://127.0.0.1:9" },
    };

    describe("createTerminalAdapter", () => {
        // Offline, the core shows the pairing link, then fails pairing when it
        // cannot reach the statement store, naming the endpoint.
        test("starts without a session, shows a pairing link, keeps the device identity and reports an unreachable chain", async () => {
            const storageDir = await mkdtemp(join(tmpdir(), "terminal-adapter-"));
            const adapter = await createTerminalAdapter({
                appId: "terminal-test.dot",
                network: offline,
                storageDir,
            });
            try {
                const before = adapter.session;
                const deeplinks: string[] = [];
                const ended = await adapter
                    .login({ onPairing: (link) => deeplinks.push(link) })
                    .then(
                        () => "resolved",
                        (error: Error) => error.message,
                    );
                const stored = (await readdir(join(storageDir, "core"))).map(
                    (file) => file.split("-")[0],
                );
                expect({
                    before,
                    deeplinks: deeplinks.map((link) =>
                        /^polkadotapp:\/\/pair\?handshake=[0-9a-f]+$/.test(link),
                    ),
                    stored,
                    ended: ended.includes("Could not connect to ws://127.0.0.1:9"),
                }).toEqual({
                    before: undefined,
                    deeplinks: [true],
                    stored: ["PairingDeviceIdentity"],
                    ended: true,
                });
            } finally {
                await adapter.destroy();
                await rm(storageDir, { recursive: true, force: true });
            }
        }, 30_000);
    });
}
