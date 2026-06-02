// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { JsonRpcProvider } from "polkadot-api";
import { createLogger } from "@parity/product-sdk-logger";
import { enumValue, type Transport } from "@novasamatech/host-api";

import type { HostLocalStorage, HostStatementStore } from "./types.js";

const log = createLogger("host:container");

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
 *
 * Uses product-sdk's sandboxProvider as primary detection.
 * Falls back to manual signal checks when product-sdk is not installed.
 */
export async function isInsideContainer(): Promise<boolean> {
    if (typeof window === "undefined") return false;

    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.sandboxProvider.isCorrectEnvironment();
    } catch {
        return isInsideContainerSync();
    }
}

/**
 * Get the Host API localStorage instance when running inside a container.
 * Returns null outside a container or when product-sdk is unavailable.
 */
export async function getHostLocalStorage(): Promise<HostLocalStorage | null> {
    if (!(await isInsideContainer())) return null;

    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.hostLocalStorage as HostLocalStorage;
    } catch (err) {
        log.debug("getHostLocalStorage unavailable", err);
        return null;
    }
}

/**
 * Construct a fresh host-backed `HostLocalStorage` instance with an optional
 * custom transport. Use this when you need a non-default transport (e.g.
 * for tests); otherwise prefer {@link getHostLocalStorage}, which returns
 * the shared singleton.
 *
 * Mirrors `createLocalStorage` from `@novasamatech/host-api-wrapper`.
 *
 * @param transport - Optional transport; defaults to the sandbox transport.
 * @returns A new `HostLocalStorage` instance, or `null` if unavailable.
 */
export async function createHostLocalStorage(
    transport?: Transport,
): Promise<HostLocalStorage | null> {
    if (!(await isInsideContainer())) return null;

    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.createLocalStorage(transport);
    } catch (err) {
        log.debug("createHostLocalStorage unavailable", err);
        return null;
    }
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

/**
 * Synchronous container detection — fast heuristic check without product-sdk.
 *
 * Checks for iframe, webview marker, and host message port signals.
 * Use this when you need a quick sync check (e.g., in hot code paths).
 * For full detection including product-sdk, use {@link isInsideContainer} (async).
 */
export function isInsideContainerSync(): boolean {
    if (typeof window === "undefined") return false;

    const win = window as unknown as Record<string, unknown>;

    // Iframe detection (polkadot.com browser)
    try {
        if (window !== window.top) return true;
    } catch {
        // Cross-origin iframe — likely inside a container
        return true;
    }

    // Webview detection (Polkadot Desktop)
    if (win.__HOST_WEBVIEW_MARK__ === true) return true;

    // Desktop message-passing API
    if (win.__HOST_API_PORT__ != null) return true;

    return false;
}

/**
 * Get the host API statement store when running inside a container.
 *
 * Returns a statement store with `subscribe`, `createProof`, and `submit` methods
 * that communicate through the host's native binary protocol — bypassing JSON-RPC
 * entirely. Returns `null` when `@novasamatech/host-api-wrapper` is unavailable.
 *
 * @returns The host statement store, or `null` if unavailable.
 */
export async function getStatementStore(): Promise<HostStatementStore | null> {
    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.createStatementStore() as HostStatementStore;
    } catch (err) {
        log.debug("getStatementStore unavailable", err);
        return null;
    }
}

if (import.meta.vitest) {
    const { test, expect, vi } = import.meta.vitest;

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

    test("returns false in Node environment (no window)", async () => {
        expect(await isInsideContainer()).toBe(false);
    });

    test("manualDetection returns true for __HOST_WEBVIEW_MARK__", async () => {
        const fakeWindow = {
            top: null,
            __HOST_WEBVIEW_MARK__: true,
        };
        vi.stubGlobal("window", fakeWindow);
        const result = await isInsideContainer();
        expect(result).toBe(true);
        vi.unstubAllGlobals();
    });

    test("manualDetection returns true for __HOST_API_PORT__", async () => {
        const fakeWindow = {
            top: null,
            __HOST_API_PORT__: 12345,
        };
        vi.stubGlobal("window", fakeWindow);
        const result = await isInsideContainer();
        expect(result).toBe(true);
        vi.unstubAllGlobals();
    });

    test("manualDetection returns false when no signals present", async () => {
        const fakeWindow = { top: null };
        Object.defineProperty(fakeWindow, "top", { get: () => fakeWindow });
        vi.stubGlobal("window", fakeWindow);
        const result = await isInsideContainer();
        expect(result).toBe(false);
        vi.unstubAllGlobals();
    });

    test("manualDetection returns true for cross-origin iframe", async () => {
        const fakeWindow = {};
        Object.defineProperty(fakeWindow, "top", {
            get: () => {
                throw new DOMException("cross-origin");
            },
        });
        vi.stubGlobal("window", fakeWindow);
        const result = await isInsideContainer();
        expect(result).toBe(true);
        vi.unstubAllGlobals();
    });

    test("manualDetection returns true when window !== window.top (iframe)", async () => {
        const fakeWindow = { top: {} }; // top is a different object
        vi.stubGlobal("window", fakeWindow);
        const result = await isInsideContainer();
        expect(result).toBe(true);
        vi.unstubAllGlobals();
    });

    test("getHostLocalStorage returns null outside container", async () => {
        expect(await getHostLocalStorage()).toBeNull();
    });

    test("createHostLocalStorage returns null outside container", async () => {
        expect(await createHostLocalStorage()).toBeNull();
    });

    // --- chain-support gating (resolveHostProvider) ---

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

    test("getStatementStore returns null when product-sdk unavailable", async () => {
        const result = await getStatementStore();
        expect(result).toBeNull();
    });
}
