// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { JsonRpcProvider } from "polkadot-api";
import type { HexString, TrUApiClient } from "@parity/truapi";

import { formatHostError } from "./errors.js";
import { createHostPapiProvider } from "./papi-provider.js";
import { getClient, isCorrectEnvironment, subscribeWithInterrupt } from "./transport.js";
import { fromHex, toHex, unwrapHostResult } from "./truapi.js";
import type { HostLocalStorage, HostStatementStore } from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Synchronous container detection — fast heuristic check (iframe, webview
 * marker, or injected host message port). Re-exported from the transport
 * bootstrap, which owns the detection logic.
 */
export { isCorrectEnvironment as isInsideContainerSync } from "./transport.js";

/**
 * Thrown by {@link getHostProvider} when the host container is reachable but does
 * not support the requested chain — e.g. the chain isn't enabled in this host
 * build, or the descriptor's genesis hash has drifted from the host's after a
 * network reset.
 *
 * Surfacing this as a thrown error (rather than handing back a provider that
 * silently swallows every JSON-RPC request) is what lets callers of
 * `createChainClient` detect the failure. Without it, the host's fallback no-op
 * provider drops every request on the floor and queries await forever.
 */
export class ChainNotSupportedError extends Error {
    /** Genesis hash of the chain the host refused, for programmatic detection. */
    readonly genesisHash: string;

    constructor(genesisHash: string) {
        super(
            `Chain ${genesisHash} is not supported by the current host. It may not be enabled in this host build, or its genesis hash may have drifted after a network reset.`,
        );
        this.name = "ChainNotSupportedError";
        this.genesisHash = genesisHash;
    }
}

/**
 * Ask the host whether it can serve the given chain, via
 * `system.featureSupported({ tag: "Chain", … })`. Gates {@link getHostProvider}
 * the same way the upstream wrapper's provider gated itself internally before
 * deciding whether to start a real provider or a no-op one.
 *
 * @throws If the host rejects the support check outright — a non-hanging,
 *   catchable failure.
 */
async function isChainSupportedByHost(
    client: TrUApiClient,
    genesisHash: HexString,
): Promise<boolean> {
    return client.system.featureSupported({ tag: "Chain", value: { genesisHash } }).match(
        (response) => response.supported,
        (error) => {
            throw new Error(
                `Host rejected the chain-support check for ${genesisHash}: ${formatHostError(error)}`,
            );
        },
    );
}

/**
 * Detect if running inside a Host container (Polkadot Browser / Polkadot Desktop).
 *
 * The SDK is designed to run exclusively inside a host container. This function
 * is primarily useful for early validation or informational purposes.
 */
export async function isInsideContainer(): Promise<boolean> {
    return isCorrectEnvironment();
}

/**
 * Adapt the TruAPI client's raw `localStorage` domain (hex-encoded
 * `read`/`write`/`clear`) into the richer {@link HostLocalStorage} surface that
 * the Storage package's `KvStore` and other consumers expect.
 */
function adaptLocalStorage(client: TrUApiClient): HostLocalStorage {
    const ls = client.localStorage;

    async function readBytes(key: string): Promise<Uint8Array | undefined> {
        const response = await unwrapHostResult(ls.read({ key }), "host localStorage read failed");
        return response.value !== undefined ? fromHex(response.value) : undefined;
    }

    async function writeBytes(key: string, value: Uint8Array): Promise<void> {
        await unwrapHostResult(
            ls.write({ key, value: toHex(value) }),
            "host localStorage write failed",
        );
    }

    async function readString(key: string): Promise<string> {
        const bytes = await readBytes(key);
        return bytes ? textDecoder.decode(bytes) : "";
    }

    async function writeString(key: string, value: string): Promise<void> {
        return writeBytes(key, textEncoder.encode(value));
    }

    async function readJSON(key: string): Promise<unknown> {
        const text = await readString(key);
        return text ? JSON.parse(text) : null;
    }

    async function writeJSON(key: string, value: unknown): Promise<void> {
        return writeString(key, JSON.stringify(value));
    }

    async function clear(key: string): Promise<void> {
        await unwrapHostResult(ls.clear({ key }), "host localStorage clear failed");
    }

    return { readString, writeString, readJSON, writeJSON, readBytes, writeBytes, clear };
}

/**
 * Get the Host API localStorage instance when running inside a container.
 * Returns null outside a container or when the host transport is unavailable.
 */
export async function getHostLocalStorage(): Promise<HostLocalStorage | null> {
    const client = await getClient();
    return client ? adaptLocalStorage(client) : null;
}

/**
 * Construct a host-backed `HostLocalStorage` instance. Retained for API
 * compatibility; with the single cached TruAPI client this is equivalent to
 * {@link getHostLocalStorage}.
 *
 * @returns A `HostLocalStorage` instance, or `null` if unavailable.
 */
export async function createHostLocalStorage(): Promise<HostLocalStorage | null> {
    return getHostLocalStorage();
}

/**
 * Get a PAPI-compatible JSON-RPC provider that routes through the host connection.
 *
 * When running inside a Polkadot container, this builds a `JsonRpcProvider` over
 * `truApi.chain.*` (see {@link module:papi-provider}), enabling shared
 * connections and efficient routing. Returns `null` when not running inside a
 * container.
 *
 * @param genesisHash - Genesis hash of the target chain (`0x`-prefixed hex string).
 * @returns A host-routed `JsonRpcProvider`, or `null` if unavailable.
 * @throws {ChainNotSupportedError} When inside a container but the host can't serve
 *   the chain — surfaced instead of returning a provider that would hang forever.
 */
export async function getHostProvider(genesisHash: HexString): Promise<JsonRpcProvider | null> {
    const client = await getClient();
    if (!client) return null;
    return resolveHostProvider(client, genesisHash);
}

/**
 * Decide whether to build a host provider for `genesisHash`, given a ready
 * TruAPI client. Split out of {@link getHostProvider} so the decision logic can
 * be unit-tested with a fake client.
 *
 * @returns the provider.
 * @throws {ChainNotSupportedError} when the host can't serve the chain.
 */
async function resolveHostProvider(
    client: TrUApiClient,
    genesisHash: HexString,
): Promise<JsonRpcProvider> {
    // Confirm the host can actually serve this chain before handing PAPI a
    // provider. When the host doesn't support the chain, a provider would silently
    // swallow every JSON-RPC request and the caller hangs forever with no
    // rejection. Surface a catchable error instead.
    if (!(await isChainSupportedByHost(client, genesisHash))) {
        throw new ChainNotSupportedError(genesisHash);
    }

    return createHostPapiProvider(client, genesisHash);
}

/** Build a {@link HostStatementStore} over a TruAPI client's `statementStore` domain. */
function adaptStatementStore(client: TrUApiClient): HostStatementStore {
    const ss = client.statementStore;
    return {
        subscribe(filter, callback) {
            const request =
                "matchAll" in filter
                    ? ({ tag: "MatchAll", value: filter.matchAll } as const)
                    : ({ tag: "MatchAny", value: filter.matchAny } as const);
            // `RemoteStatementStoreSubscribeItem` is structurally a StatementsPage.
            return subscribeWithInterrupt(ss.subscribe({ request }), callback);
        },
        async createProofAuthorized(statement) {
            const response = await unwrapHostResult(
                ss.createProofAuthorized(statement),
                "createProofAuthorized failed",
            );
            return response.proof;
        },
        async submit(signedStatement) {
            await unwrapHostResult(ss.submit(signedStatement), "statement submit failed");
        },
    };
}

/**
 * Get the host statement store when running inside a container, backed by
 * `truApi.statementStore.*`.
 *
 * Returns a store with `subscribe`, `createProofAuthorized`, and `submit` that
 * communicate through the host's native binary protocol — bypassing JSON-RPC
 * entirely. Returns `null` outside a host container.
 *
 * @returns The host statement store, or `null` if unavailable.
 */
export async function getStatementStore(): Promise<HostStatementStore | null> {
    const client = await getClient();
    return client ? adaptStatementStore(client) : null;
}

if (import.meta.vitest) {
    const { test, expect, vi, afterEach } = import.meta.vitest;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // A self-contained fake TruAPI client exposing just the `system` and `chain`
    // domains the provider gate touches, so the chain-support decision can be
    // tested without a real host connection.
    function makeFakeClient(opts: { supported?: boolean; featureErr?: string | null }) {
        const { supported = true, featureErr = null } = opts;
        return {
            system: {
                featureSupported: (_request: unknown) => ({
                    match: (
                        okFn: (ok: { supported: boolean }) => boolean,
                        errFn: (err: { reason: string }) => boolean,
                    ) => (featureErr ? errFn({ reason: featureErr }) : okFn({ supported })),
                }),
            },
            // Read synchronously by createHostPapiProvider; never invoked here.
            chain: {},
        } as unknown as TrUApiClient;
    }

    test("isInsideContainer is false in a Node environment (no window)", async () => {
        expect(await isInsideContainer()).toBe(false);
    });

    test("isInsideContainer detects an injected host port", async () => {
        const win = {};
        Object.defineProperty(win, "top", { get: () => win });
        (win as Record<string, unknown>).__HOST_API_PORT__ = 12345;
        vi.stubGlobal("window", win);
        expect(await isInsideContainer()).toBe(true);
    });

    test("getHostLocalStorage returns null outside container", async () => {
        expect(await getHostLocalStorage()).toBeNull();
    });

    test("createHostLocalStorage returns null outside container", async () => {
        expect(await createHostLocalStorage()).toBeNull();
    });

    test("adaptLocalStorage round-trips strings, JSON, and bytes over the TruAPI client", async () => {
        // Minimal in-memory fake of the TruAPI localStorage domain (hex values).
        const store = new Map<string, `0x${string}`>();
        const okAsync = <T>(value: T) => ({
            match: async (onOk: (v: T) => unknown) => onOk(value),
        });
        const fakeClient = {
            localStorage: {
                read: ({ key }: { key: string }) => okAsync({ value: store.get(key) }),
                write: ({ key, value }: { key: string; value: `0x${string}` }) => {
                    store.set(key, value);
                    return okAsync(undefined);
                },
                clear: ({ key }: { key: string }) => {
                    store.delete(key);
                    return okAsync(undefined);
                },
            },
        } as unknown as TrUApiClient;

        const ls = adaptLocalStorage(fakeClient);
        expect(await ls.readString("missing")).toBe("");
        expect(await ls.readJSON("missing")).toBeNull();
        expect(await ls.readBytes("missing")).toBeUndefined();

        await ls.writeString("s", "hello");
        expect(await ls.readString("s")).toBe("hello");

        await ls.writeJSON("j", { a: 1 });
        expect(await ls.readJSON("j")).toEqual({ a: 1 });

        await ls.writeBytes("b", new Uint8Array([1, 2, 3]));
        expect(Array.from((await ls.readBytes("b")) ?? [])).toEqual([1, 2, 3]);

        await ls.clear("s");
        expect(await ls.readString("s")).toBe("");
    });

    // --- chain-support gating (resolveHostProvider over truApi.system/chain) ---

    test("resolves to a provider when the host supports the chain", async () => {
        const provider = await resolveHostProvider(makeFakeClient({ supported: true }), "0xabc");
        // createHostPapiProvider returns a JsonRpcProvider (an onMessage -> connection fn).
        expect(typeof provider).toBe("function");
    });

    test("throws ChainNotSupportedError when the host doesn't support the chain", async () => {
        const err = await resolveHostProvider(makeFakeClient({ supported: false }), "0xfeed").catch(
            (e) => e,
        );
        expect(err).toBeInstanceOf(ChainNotSupportedError);
        expect((err as ChainNotSupportedError).genesisHash).toBe("0xfeed");
    });

    test("throws when the host rejects the support check", async () => {
        await expect(
            resolveHostProvider(makeFakeClient({ featureErr: "boom" }), "0xabc"),
        ).rejects.toThrow(/boom/);
    });

    test("getHostProvider returns null outside a container", async () => {
        expect(await getHostProvider("0xabc")).toBeNull();
    });

    test("getStatementStore returns null outside a container", async () => {
        expect(await getStatementStore()).toBeNull();
    });
}
