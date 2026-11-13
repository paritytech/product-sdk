// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { SharedChain } from "./types.js";

declare global {
    var __chainClientCache: Map<string, SharedChain> | undefined;
}

/**
 * Get the HMR-safe cache of shared chains, keyed by genesis hash. It lives on
 * `globalThis`, so a module reload reuses the chains it already holds instead of
 * following each of them again.
 */
export function getClientCache(): Map<string, SharedChain> {
    globalThis.__chainClientCache ??= new Map();
    return globalThis.__chainClientCache;
}

/** Clear all entries from the client cache. Destroys active clients. */
export function clearClientCache(): void {
    const cache = getClientCache();
    for (const entry of cache.values()) {
        destroyClient(entry);
    }
    cache.clear();
}

/** Destroy a shared chain's client, now or once it exists. */
export function destroyClient(entry: SharedChain): void {
    if (entry.client instanceof Promise) {
        // Still being created: close it as soon as it exists. A failed creation
        // has nothing to close.
        entry.client.then(
            (client) => {
                try {
                    client.destroy();
                } catch {
                    // client may already be destroyed
                }
            },
            () => {},
        );
        return;
    }
    try {
        entry.client.destroy();
    } catch {
        // client may already be destroyed
    }
}

if (import.meta.vitest) {
    const { test, expect, vi } = import.meta.vitest;

    test("getClientCache returns a Map", () => {
        const cache = getClientCache();
        expect(cache).toBeInstanceOf(Map);
    });

    test("getClientCache returns the same instance on repeated calls", () => {
        const a = getClientCache();
        const b = getClientCache();
        expect(a).toBe(b);
    });

    test("destroyClient closes a client still being created once it exists", async () => {
        let destroyed = 0;
        const client = { destroy: () => void destroyed++ } as never;
        const entry: SharedChain = { client: Promise.resolve(client), api: new Map(), users: 0 };
        destroyClient(entry);
        expect(destroyed).toBe(0);
        await Promise.resolve();
        expect(destroyed).toBe(1);
    });

    test("destroyClient twice on a client still being created does not reject", async () => {
        let destroyed = 0;
        const client = {
            destroy: () => {
                destroyed += 1;
                if (destroyed > 1) throw new Error("already destroyed");
            },
        } as never;
        const entry: SharedChain = { client: Promise.resolve(client), api: new Map(), users: 0 };
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            destroyClient(entry);
            destroyClient(entry);
            await new Promise((resolve) => setTimeout(resolve, 0));
        } finally {
            process.off("unhandledRejection", unhandled);
        }
        expect(destroyed).toBe(2);
        expect(unhandled).not.toHaveBeenCalled();
    });

    test("destroyClient ignores a creation that failed", async () => {
        const failed = Promise.reject(new Error("no host"));
        const entry: SharedChain = { client: failed, api: new Map(), users: 0 };
        expect(() => destroyClient(entry)).not.toThrow();
        await expect(failed).rejects.toThrow("no host");
    });
}
