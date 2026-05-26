// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainEntry } from "./types.js";

declare global {
    var __chainClientCache: Map<string, ChainEntry> | undefined;
}

/** Get the HMR-safe client cache, keyed by genesis hash. */
export function getClientCache(): Map<string, ChainEntry> {
    globalThis.__chainClientCache ??= new Map();
    return globalThis.__chainClientCache;
}

/** Clear all entries from the client cache. Destroys active clients. */
export function clearClientCache(): void {
    const cache = getClientCache();
    for (const entry of cache.values()) {
        try {
            entry.client.destroy();
        } catch {
            // client may already be destroyed
        }
    }
    cache.clear();
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getClientCache returns a Map", () => {
        const cache = getClientCache();
        expect(cache).toBeInstanceOf(Map);
    });

    test("getClientCache returns the same instance on repeated calls", () => {
        const a = getClientCache();
        const b = getClientCache();
        expect(a).toBe(b);
    });
}
