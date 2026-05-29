// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { JsonRpcProvider } from "polkadot-api";
import { createLogger } from "@parity/product-sdk-logger";
import type { Transport } from "@novasamatech/host-api";

import type { HostLocalStorage, HostStatementStore } from "./types.js";

const log = createLogger("host:container");

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
 * Returns `null` when `@novasamatech/host-api-wrapper` is unavailable.
 *
 * @param genesisHash - Genesis hash of the target chain (`0x`-prefixed hex string).
 * @returns A host-routed `JsonRpcProvider`, or `null` if unavailable.
 */
export async function getHostProvider(genesisHash: `0x${string}`): Promise<JsonRpcProvider | null> {
    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.createPapiProvider(genesisHash);
    } catch (err) {
        log.debug("getHostProvider unavailable", err);
        return null;
    }
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

    test("getHostProvider returns null when product-sdk unavailable", async () => {
        const result = await getHostProvider("0xabc");
        expect(result).toBeNull();
    });

    test("getStatementStore returns null when product-sdk unavailable", async () => {
        const result = await getStatementStore();
        expect(result).toBeNull();
    });
}
