// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition, PolkadotClient } from "polkadot-api";
import { createClient } from "polkadot-api";
import { createProvider } from "./providers.js";
import { getClientCache, clearClientCache } from "./hmr.js";
import type { ChainEntry, ChainClientConfig, ChainClient } from "./types.js";

// Cache keys are scoped by a fingerprint of the config so that two
// `createChainClient` calls with different chain sets don't collide.
const cacheKey = (fingerprint: string, genesis: string) => `${fingerprint}:${genesis}`;

function findEntryByGenesis(genesis: string): ChainEntry | undefined {
    for (const [key, entry] of getClientCache()) {
        if (key.endsWith(`:${genesis}`)) return entry;
    }
}

const clientInstances = new Map<string, Promise<ChainClient<any>>>();

/** Build a stable fingerprint from sorted chain names + genesis hashes. */
function configFingerprint(chains: Record<string, ChainDefinition>): string {
    return Object.entries(chains)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, desc]) => `${name}:${desc.genesis ?? "unknown"}`)
        .join("|");
}

/**
 * Create a multi-chain client with user-provided descriptors and RPC endpoints.
 *
 * Returns fully-typed APIs for each chain plus raw `PolkadotClient` access via `.raw`.
 * Connections route through the host provider (`@parity/product-sdk-host`) — the SDK
 * is designed to run exclusively inside a host container (Polkadot Browser / Desktop).
 * Throws if no host provider is available; there is no direct-WebSocket fallback.
 *
 * The `config.rpcs` field is currently unused at runtime (kept for API compatibility
 * and BYOD documentation), since the host owns the chain connection.
 *
 * Results are cached by genesis-hash fingerprint — calling with the same descriptors
 * returns the same instance.
 *
 * @example
 * ```ts
 * import { createChainClient } from "@parity/product-sdk-chain-client";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub, bulletin: paseo_bulletin },
 *     rpcs: {
 *         assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"],
 *         bulletin: ["wss://paseo-bulletin-next-rpc.polkadot.io"],
 *     },
 * });
 *
 * // Fully typed from your descriptors
 * const account = await client.assetHub.query.System.Account.getValue(addr);
 * const fee = await client.bulletin.query.TransactionStorage.ByteFee.getValue();
 *
 * // Raw client for advanced use (e.g., a ContractRuntime for pallet-revive contracts)
 * import { createContractRuntimeFromClient } from "@parity/product-sdk-contracts";
 * const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub);
 *
 * // Cleanup
 * client.destroy();
 * ```
 */
export async function createChainClient<const TChains extends Record<string, ChainDefinition>>(
    config: ChainClientConfig<TChains>,
): Promise<ChainClient<TChains>> {
    const fingerprint = configFingerprint(config.chains);

    const existing = clientInstances.get(fingerprint);
    if (existing) return existing as Promise<ChainClient<TChains>>;

    const promise = initChainClient(config, fingerprint).catch((err) => {
        // Clean up any clients created before the failure to avoid leaking
        // WebSocket connections that are unreachable except via destroyAll().
        const cache = getClientCache();
        for (const [key, entry] of cache) {
            if (key.startsWith(`${fingerprint}:`)) {
                try {
                    entry.client.destroy();
                } catch {
                    /* already destroyed */
                }
                cache.delete(key);
            }
        }
        clientInstances.delete(fingerprint);
        throw err;
    });
    clientInstances.set(fingerprint, promise);
    return promise;
}

/* @integration */
async function initChainClient<const TChains extends Record<string, ChainDefinition>>(
    config: ChainClientConfig<TChains>,
    fingerprint: string,
): Promise<ChainClient<TChains>> {
    const names = Object.keys(config.chains) as (string & keyof TChains)[];
    const clientCache = getClientCache();

    // Create providers and clients in parallel
    const entries = await Promise.all(
        names.map(async (name) => {
            const descriptor = config.chains[name] as ChainDefinition;
            const genesis = descriptor.genesis;
            if (!genesis) {
                throw new Error(`Descriptor for chain "${name}" has no genesis hash.`);
            }
            const provider = await createProvider(genesis);
            const client = createClient(provider);

            // Populate HMR cache so getClient() and isConnected() work
            const key = cacheKey(fingerprint, genesis);
            if (!clientCache.has(key)) {
                clientCache.set(key, {
                    client,
                    api: new Map(),
                } satisfies ChainEntry);
            }

            return { name, descriptor, client, genesis };
        }),
    );

    // Build typed APIs and raw client map
    const apis = {} as Record<string, unknown>;
    const raw = {} as Record<string, PolkadotClient>;

    for (const { name, descriptor, client } of entries) {
        apis[name] = client.getTypedApi(descriptor);
        raw[name] = client;
    }

    return {
        ...apis,
        raw,
        destroy() {
            for (const { genesis } of entries) {
                const key = cacheKey(fingerprint, genesis);
                const entry = clientCache.get(key);
                if (entry) {
                    try {
                        entry.client.destroy();
                    } catch {
                        /* already destroyed */
                    }
                    clientCache.delete(key);
                }
            }
            clientInstances.delete(fingerprint);
        },
    } as ChainClient<TChains>;
}

/**
 * Destroy all chain client instances and reset internal caches.
 *
 * Tears down every connection created by {@link createChainClient}.
 */
export function destroyAll(): void {
    clearClientCache();
    clientInstances.clear();
}

/**
 * Get the raw `PolkadotClient` for a connected chain by its descriptor.
 *
 * The chain must have been initialized via {@link createChainClient} first.
 * Alternatively, use `client.raw.<name>` on the returned {@link ChainClient}.
 *
 * @throws If the chain has not been connected yet.
 */
export function getClient(descriptor: ChainDefinition): PolkadotClient {
    const genesis = descriptor.genesis;
    if (!genesis) throw new Error("Descriptor has no genesis hash.");
    const entry = findEntryByGenesis(genesis);
    if (!entry?.client) {
        throw new Error(
            `Chain not connected (genesis: ${genesis}). Call createChainClient() first to establish connections.`,
        );
    }
    return entry.client;
}

/**
 * Check if a chain is currently connected.
 *
 * Synchronous — no side effects, no initialization.
 */
export function isConnected(descriptor: ChainDefinition): boolean {
    const genesis = descriptor.genesis;
    if (!genesis) return false;
    return findEntryByGenesis(genesis) !== undefined;
}

if (import.meta.vitest) {
    const { test, expect, beforeEach } = import.meta.vitest;

    const fakeDescriptor = { genesis: "0xtest" } as ChainDefinition;
    const fakeClient = {
        destroy: () => {},
        getTypedApi: () => ({}),
    } as unknown as PolkadotClient;

    function seedCache(genesis: string, client: PolkadotClient, fp = "test") {
        getClientCache().set(cacheKey(fp, genesis), {
            client,
            api: new Map(),
        });
    }

    beforeEach(() => {
        clearClientCache();
        clientInstances.clear();
    });

    // --- isConnected ---

    test("isConnected returns false for unknown chain", () => {
        expect(isConnected(fakeDescriptor)).toBe(false);
    });

    test("isConnected returns true after cache is populated", () => {
        seedCache("0xtest", fakeClient);
        expect(isConnected(fakeDescriptor)).toBe(true);
    });

    test("isConnected returns false for descriptor without genesis", () => {
        expect(isConnected({} as ChainDefinition)).toBe(false);
    });

    // --- getClient ---

    test("getClient returns client from cache", () => {
        seedCache("0xtest", fakeClient);
        expect(getClient(fakeDescriptor)).toBe(fakeClient);
    });

    test("getClient throws for unconnected chain", () => {
        expect(() => getClient(fakeDescriptor)).toThrow(/Chain not connected/);
    });

    test("getClient throws for descriptor without genesis", () => {
        expect(() => getClient({} as ChainDefinition)).toThrow(/no genesis hash/);
    });

    // --- destroyAll ---

    test("destroyAll calls client.destroy() and clears caches", () => {
        let destroyed = false;
        const trackableClient = {
            destroy: () => {
                destroyed = true;
            },
            getTypedApi: () => ({}),
        } as unknown as PolkadotClient;
        seedCache("0xtest", trackableClient);
        clientInstances.set("test", Promise.resolve({} as ChainClient<any>));
        destroyAll();
        expect(destroyed).toBe(true);
        expect(isConnected(fakeDescriptor)).toBe(false);
        expect(clientInstances.size).toBe(0);
    });

    // --- createChainClient ---

    test("createChainClient returns same promise for identical config", async () => {
        const fakeResult = {} as ChainClient<any>;
        const fp = configFingerprint({ a: fakeDescriptor });
        clientInstances.set(fp, Promise.resolve(fakeResult));
        const result = await createChainClient({
            chains: { a: fakeDescriptor },
            rpcs: { a: [] },
        });
        expect(result).toBe(fakeResult);
    });

    test("createChainClient deduplicates concurrent calls", async () => {
        const fakeResult = {} as ChainClient<any>;
        const fp = configFingerprint({ x: fakeDescriptor });
        clientInstances.set(fp, Promise.resolve(fakeResult));
        const [a, b] = await Promise.all([
            createChainClient({ chains: { x: fakeDescriptor }, rpcs: { x: [] } }),
            createChainClient({ chains: { x: fakeDescriptor }, rpcs: { x: [] } }),
        ]);
        expect(a).toBe(b);
    });

    test("createChainClient returns different results for different configs", async () => {
        const descA = { genesis: "0xaaa" } as ChainDefinition;
        const descB = { genesis: "0xbbb" } as ChainDefinition;
        const resultA = {} as ChainClient<any>;
        const resultB = {} as ChainClient<any>;
        clientInstances.set(configFingerprint({ a: descA }), Promise.resolve(resultA));
        clientInstances.set(configFingerprint({ b: descB }), Promise.resolve(resultB));
        const a = await createChainClient({ chains: { a: descA }, rpcs: { a: [] } });
        const b = await createChainClient({ chains: { b: descB }, rpcs: { b: [] } });
        expect(a).not.toBe(b);
    });

    // --- configFingerprint ---

    test("configFingerprint is stable regardless of key order", () => {
        const d1 = { genesis: "0x1" } as ChainDefinition;
        const d2 = { genesis: "0x2" } as ChainDefinition;
        expect(configFingerprint({ a: d1, b: d2 })).toBe(configFingerprint({ b: d2, a: d1 }));
    });

    // --- findEntryByGenesis ---

    test("findEntryByGenesis returns undefined for missing genesis", () => {
        expect(findEntryByGenesis("0xnonexistent")).toBeUndefined();
    });

    // --- full lifecycle ---

    test("full lifecycle: seed, verify connected, destroy, verify disconnected", () => {
        seedCache("0xtest", fakeClient);
        expect(isConnected(fakeDescriptor)).toBe(true);
        expect(getClient(fakeDescriptor)).toBe(fakeClient);
        destroyAll();
        expect(isConnected(fakeDescriptor)).toBe(false);
        expect(() => getClient(fakeDescriptor)).toThrow(/Chain not connected/);
    });

    test("two fingerprints cached independently, destroy one leaves other intact", () => {
        const sharedGenesis = "0xshared";
        const clientA = { destroy: () => {} } as PolkadotClient;
        const clientB = { destroy: () => {} } as PolkadotClient;
        const descriptorShared = { genesis: sharedGenesis } as ChainDefinition;

        seedCache(sharedGenesis, clientA, "fpA");
        seedCache(sharedGenesis, clientB, "fpB");

        expect(isConnected(descriptorShared)).toBe(true);

        // Destroy only fpA's entry
        const cache = getClientCache();
        const keyA = cacheKey("fpA", sharedGenesis);
        cache.get(keyA)?.client.destroy();
        cache.delete(keyA);

        // fpB's entry still alive
        expect(isConnected(descriptorShared)).toBe(true);
        expect(getClient(descriptorShared)).toBe(clientB);
    });
}
