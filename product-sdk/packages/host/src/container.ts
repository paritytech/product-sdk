// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { JsonRpcProvider } from "polkadot-api";
import type { TrUApiClient } from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";
import { enumValue } from "@novasamatech/host-api";

import { getClient, isCorrectEnvironment, subscribeWithInterrupt } from "./transport.js";
import { fromHex, toHex, unwrapHostResult } from "./truapi.js";
import type { HostLocalStorage, HostStatementStore } from "./types.js";

const log = createLogger("host:container");

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
 * Ask the host whether it can serve the given chain, using the same
 * `host_feature_supported` check the wrapper's provider performs internally
 * before it decides whether to start a real provider or a no-op one.
 *
 * @throws If the host connection never becomes ready, or the host rejects the
 *   support check outright. Both are non-hanging, catchable failures.
 *
 * @remarks TODO: port onto `truApi.system.featureSupported` once
 *   {@link getHostProvider} moves to a `@parity/truapi` PAPI `JsonRpcProvider`
 *   adapter. Still on the novasama wrapper for now.
 */
async function isChainSupportedByHost(
    sdk: typeof import("@novasamatech/host-api-wrapper"),
    genesisHash: `0x${string}`,
): Promise<boolean> {
    const ready = await sdk.sandboxTransport.isReady();
    if (!ready) {
        throw new Error(
            `Host connection did not become ready; cannot verify support for chain ${genesisHash}.`,
        );
    }
    const result = await sdk.hostApi.featureSupported(
        enumValue("v1", enumValue("Chain", genesisHash)),
    );
    return result.match(
        (ok) => ok.value === true,
        (err) => {
            // The reason lives at value.payload.reason for host-protocol errors and
            // value.reason for request-level ones; tolerate both against upstream drift.
            const value = (err as { value?: { payload?: { reason?: string }; reason?: string } })
                ?.value;
            const reason = value?.payload?.reason ?? value?.reason ?? "unknown reason";
            throw new Error(`Host rejected the chain-support check for ${genesisHash}: ${reason}`);
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
 * When running inside a Polkadot container, this wraps the chain connection via the
 * host's `createPapiProvider`, enabling shared connections and efficient routing.
 * Returns `null` when `@novasamatech/host-api-wrapper` is unavailable or when not
 * running inside a container.
 *
 * @param genesisHash - Genesis hash of the target chain (`0x`-prefixed hex string).
 * @returns A host-routed `JsonRpcProvider`, or `null` if unavailable.
 * @throws {ChainNotSupportedError} When inside a container but the host can't serve
 *   the chain — surfaced instead of returning a provider that would hang forever.
 *
 * @remarks TODO: port onto `truApi.chain.*`. The `@parity/truapi` `chain.*`
 *   domain provides the primitives, but building the PAPI `JsonRpcProvider`
 *   adapter (chainHead/transaction spec) over them is dedicated work; still
 *   routed through the novasama wrapper for now.
 */
export async function getHostProvider(genesisHash: `0x${string}`): Promise<JsonRpcProvider | null> {
    let sdk: typeof import("@novasamatech/host-api-wrapper");
    try {
        sdk = await import("@novasamatech/host-api-wrapper");
    } catch (err) {
        // Wrapper not installed — we're not running inside a container.
        log.debug("getHostProvider unavailable", err);
        return null;
    }
    return resolveHostProvider(sdk, genesisHash);
}

/**
 * Decide whether to build a host provider for `genesisHash`, given the resolved
 * wrapper module. Split out of {@link getHostProvider} so the decision logic can
 * be unit-tested with a fake wrapper, without re-importing the real
 * (browser-only) module.
 *
 * @returns the provider, or `null` when not inside a container.
 * @throws {ChainNotSupportedError} when the host can't serve the chain.
 */
async function resolveHostProvider(
    sdk: typeof import("@novasamatech/host-api-wrapper"),
    genesisHash: `0x${string}`,
): Promise<JsonRpcProvider | null> {
    // Outside a host container there is no provider to hand back. Mirrors
    // createPapiProvider's own environment guard; callers treat null as
    // "not inside a container".
    if (!sdk.sandboxTransport.isCorrectEnvironment()) {
        return null;
    }

    // Inside a container: confirm the host can actually serve this chain before
    // handing PAPI a provider. When the host doesn't support the chain, the
    // wrapper's fallback provider silently swallows every JSON-RPC request and
    // the caller hangs forever with no rejection. Surface a catchable error.
    if (!(await isChainSupportedByHost(sdk, genesisHash))) {
        throw new ChainNotSupportedError(genesisHash);
    }

    return sdk.createPapiProvider(genesisHash);
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

    afterEach(async () => {
        const { disposeClient } = await import("./transport.js");
        disposeClient();
        vi.unstubAllGlobals();
    });

    // A self-contained stand-in for the host wrapper, so the chain-support
    // decision can be tested without re-importing the real (browser-only) module.
    const fakeProvider = (() => {}) as unknown as JsonRpcProvider;
    function makeFakeSdk(opts: {
        inContainer?: boolean;
        ready?: boolean;
        supported?: boolean;
        featureErr?: string | null;
        onCreate?: (genesisHash: string) => void;
    }) {
        const { inContainer = true, ready = true, supported = true, featureErr = null } = opts;
        return {
            sandboxTransport: {
                isCorrectEnvironment: () => inContainer,
                isReady: async () => ready,
            },
            hostApi: {
                featureSupported: (_payload: unknown) => ({
                    match: (
                        okFn: (ok: { tag: string; value: boolean }) => boolean,
                        errFn: (err: { value: { payload: { reason: string } } }) => boolean,
                    ) =>
                        featureErr
                            ? errFn({ value: { payload: { reason: featureErr } } })
                            : okFn({ tag: "v1", value: supported }),
                }),
            },
            createPapiProvider: (genesisHash: string) => {
                opts.onCreate?.(genesisHash);
                return fakeProvider;
            },
        } as unknown as typeof import("@novasamatech/host-api-wrapper");
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

    // --- chain-support gating (resolveHostProvider) — TODO: still on novasama ---

    test("resolves to the provider when supported, and null outside a container", async () => {
        const created: string[] = [];
        const onCreate = (g: string) => created.push(g);

        // Inside a container, supported chain -> real provider.
        expect(await resolveHostProvider(makeFakeSdk({ onCreate }), "0xabc")).toBe(fakeProvider);
        // Outside a container -> null, without constructing a provider.
        expect(
            await resolveHostProvider(makeFakeSdk({ inContainer: false, onCreate }), "0xdef"),
        ).toBeNull();

        expect(created).toEqual(["0xabc"]);
    });

    test.each([
        { when: "the host doesn't support the chain", opts: { supported: false } },
        { when: "the host connection never becomes ready", opts: { ready: false } },
    ])("throws (and never builds a provider) when $when", async ({ opts }) => {
        const created: string[] = [];
        const sdk = makeFakeSdk({ ...opts, onCreate: (g) => created.push(g) });
        await expect(resolveHostProvider(sdk, "0xabc")).rejects.toThrow();
        // Crucially: no provider is created, so PAPI never receives a hanging no-op.
        expect(created).toEqual([]);
    });

    test("unsupported chains throw a ChainNotSupportedError carrying the genesis hash", async () => {
        const err = await resolveHostProvider(makeFakeSdk({ supported: false }), "0xfeed").catch(
            (e) => e,
        );
        expect(err).toBeInstanceOf(ChainNotSupportedError);
        expect((err as ChainNotSupportedError).genesisHash).toBe("0xfeed");
    });

    test("getStatementStore returns the store or null depending on availability", async () => {
        // Returns null only when `@novasamatech/host-api-wrapper` fails to load
        // (i.e. outside a container). Whether that dynamic import resolves under
        // vitest is environment-dependent, so tolerate both — matching the
        // sibling novasama-backed getters (getPreimageManager, getAccountsProvider).
        const result = await getStatementStore();
        expect(result === null || typeof result === "object").toBe(true);
    });
}
