// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { getHostProvider } from "@parity/product-sdk-host";
import type { JsonRpcProvider } from "polkadot-api";

/**
 * Create a PAPI-compatible JSON-RPC provider for a chain.
 *
 * Routes connections through the host provider (`@parity/product-sdk-host`).
 * The SDK is designed to run exclusively inside a host container.
 *
 * @throws {Error} If the host provider is unavailable (not inside a container).
 */
export async function createProvider(genesisHash: string): Promise<JsonRpcProvider> {
    const hostProvider = await getHostProvider(genesisHash as `0x${string}`);
    if (!hostProvider) {
        throw new Error(
            `Host provider unavailable for chain ${genesisHash}. Ensure you are running inside a host container (Polkadot Browser / Desktop).`,
        );
    }
    return hostProvider;
}

if (import.meta.vitest) {
    const { test, expect, vi, beforeEach } = import.meta.vitest;

    // Shared state between hoisted mocks and tests
    const state = vi.hoisted(() => ({
        fakeProvider: (() => {}) as unknown as JsonRpcProvider,
        hostProviderCalls: [] as unknown[][],
        hostProviderAvailable: true,
        hostProviderError: null as Error | null,
    }));

    vi.mock("@parity/product-sdk-host", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@parity/product-sdk-host")>()),
        getHostProvider: async (...args: unknown[]) => {
            state.hostProviderCalls.push(args);
            if (state.hostProviderError) throw state.hostProviderError;
            if (!state.hostProviderAvailable) return null;
            return state.fakeProvider;
        },
    }));

    beforeEach(() => {
        state.hostProviderCalls = [];
        state.hostProviderAvailable = true;
        state.hostProviderError = null;
    });

    test("returns host provider when available", async () => {
        const result = await createProvider("0xabc");
        expect(result).toBe(state.fakeProvider);
        expect(state.hostProviderCalls.length).toBe(1);
        expect(state.hostProviderCalls[0][0]).toBe("0xabc");
    });

    test("throws when host provider unavailable", async () => {
        state.hostProviderAvailable = false;
        await expect(createProvider("0xabc")).rejects.toThrow(/Host provider unavailable/);
    });

    test("propagates ChainNotSupportedError from the host provider", async () => {
        const { ChainNotSupportedError } = await import("@parity/product-sdk-host");
        state.hostProviderError = new ChainNotSupportedError("0xabc");
        // The unsupported-chain error must surface to the caller rather than being
        // collapsed into the generic "unavailable" path or swallowed.
        await expect(createProvider("0xabc")).rejects.toBeInstanceOf(ChainNotSupportedError);
    });
}
