// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition, PolkadotClient } from "polkadot-api";
import { createClient } from "polkadot-api";
import { createLogger } from "@parity/product-sdk-logger";
import { ChainNotSupportedError } from "@parity/product-sdk-host";
import { createProvider } from "./providers.js";
import { getClientCache, clearClientCache, destroyClient } from "./hmr.js";
import type { SharedChain, ChainClientConfig, ChainClient } from "./types.js";

const log = createLogger("chain-client");

/**
 * Build a stand-in for a chain the host can't serve. Any property access (e.g.
 * `.query`, `.tx`) or call throws the original {@link ChainNotSupportedError},
 * so touching an unsupported chain surfaces a clear, detectable error rather
 * than hanging — without tanking the supported chains in the same client.
 */
function unsupportedChainApi(error: ChainNotSupportedError): never {
    const handler: ProxyHandler<() => void> = {
        get: () => {
            throw error;
        },
        apply: () => {
            throw error;
        },
    };
    return new Proxy((() => {}) as () => void, handler) as never;
}

/** A started config: its typed APIs and raw clients, and the chains it holds. */
interface BuiltConfig {
    apis: Record<string, unknown>;
    raw: Record<string, PolkadotClient>;
    chains: AcquiredChain[];
}

/**
 * A config in use. Every `createChainClient` call with the same descriptors
 * gets a {@link ChainClient} over this one build, which holds its chains until
 * the last of those callers destroys its client.
 */
interface ConfigEntry {
    built: Promise<BuiltConfig>;
    callers: number;
}

// One build per config, by fingerprint. The chains underneath are shared
// across configs by genesis hash.
const clientInstances = new Map<string, ConfigEntry>();

/** Build a stable fingerprint from sorted chain names + genesis hashes. */
function configFingerprint(chains: Record<string, ChainDefinition>): string {
    return Object.entries(chains)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, desc]) => `${name}:${desc.genesis ?? "unknown"}`)
        .join("|");
}

/** The chain's client, once {@link acquireChain} has resolved it. */
function readyClient(entry: SharedChain): PolkadotClient | undefined {
    return entry.client instanceof Promise ? undefined : entry.client;
}

/**
 * Take a hold on the product's client for `genesis`, creating it when no one
 * holds it yet. Every {@link ChainClient} that uses the chain holds this one
 * client, so however many configs ask for a chain, the product follows it once.
 * The hold is counted at once, before the client exists, so a config that is
 * destroyed while another is still starting on the same chain leaves it alive.
 */
async function acquireChain(genesis: string): Promise<{
    shared: SharedChain;
    client: PolkadotClient;
}> {
    const cache = getClientCache();
    let shared = cache.get(genesis);
    if (shared) {
        shared.users += 1;
    } else {
        const creating = createProvider(genesis).then((provider) => createClient(provider));
        // Cached before any await, so a second call racing for this chain joins
        // this creation instead of starting its own.
        shared = { client: creating, api: new Map(), users: 1 };
        cache.set(genesis, shared);
    }
    try {
        const client = await shared.client;
        // `destroyAll()` ran while the chain was being created: it has already
        // scheduled this client's close, so it must not be handed out.
        if (cache.get(genesis) !== shared) {
            throw new Error(`Chain ${genesis} was destroyed while connecting.`);
        }
        shared.client = client;
        return { shared, client };
    } catch (err) {
        // Give back the hold. A failed creation leaves nothing behind, so the
        // next call for this chain tries again.
        releaseChain(genesis, shared);
        throw err;
    }
}

/** Give back a hold taken by {@link acquireChain}. The last one closes the client. */
function releaseChain(genesis: string, shared: SharedChain): void {
    shared.users -= 1;
    if (shared.users > 0) return;
    const cache = getClientCache();
    // `destroyAll()` has already closed an entry it removed.
    if (cache.get(genesis) !== shared) return;
    cache.delete(genesis);
    destroyClient(shared);
}

/** The typed API for `descriptor` over the chain's shared client, built once. */
function typedApi(shared: SharedChain, client: PolkadotClient, descriptor: ChainDefinition) {
    const existing = shared.api.get(descriptor);
    if (existing !== undefined) return existing;
    const api = client.getTypedApi(descriptor);
    shared.api.set(descriptor, api);
    return api;
}

/**
 * Create a multi-chain client with user-provided descriptors. No RPC endpoints are
 * configured: the host resolves each connection from the descriptor's genesis hash.
 *
 * Returns fully-typed APIs for each chain plus raw `PolkadotClient` access via `.raw`.
 * Connections route through the host provider (`@parity/product-sdk-host`) — the SDK
 * is designed to run exclusively inside a host container (Polkadot Browser / Desktop).
 * Throws if no host provider is available; there is no direct-WebSocket fallback.
 *
 * Calling with the same descriptors shares one set of typed APIs and raw clients,
 * and each call's `destroy()` gives back only that call's hold. Underneath, each
 * chain has one `PolkadotClient` for the whole product, shared by every config
 * that includes it: the host allows a product few `chainHead_v1_follow`s per
 * chain, and polkadot-api holds one per client. A chain's client closes when the
 * last {@link ChainClient} holding it is destroyed.
 *
 * @example
 * ```ts
 * import { createChainClient } from "@parity/product-sdk-chain-client";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub, bulletin: paseo_bulletin },
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
    const entry = clientInstances.get(fingerprint) ?? startConfig(config, fingerprint);
    // Counted now, so a caller that destroys its client before this call
    // resolves leaves the chains open for it.
    entry.callers += 1;
    return entry.built.then(
        (built) => chainClientOver<TChains>(built, fingerprint, entry),
        (err) => {
            entry.callers -= 1;
            throw err;
        },
    );
}

/** Start a config no caller holds yet and remember it under its fingerprint. */
function startConfig(config: ChainClientConfig<any>, fingerprint: string): ConfigEntry {
    const entry: ConfigEntry = {
        callers: 0,
        built: initChainClient(config).catch((err) => {
            // initChainClient has released the chains it acquired. Forget the
            // config so the next call for it starts over.
            if (clientInstances.get(fingerprint) === entry) clientInstances.delete(fingerprint);
            throw err;
        }),
    };
    clientInstances.set(fingerprint, entry);
    return entry;
}

/** One caller's {@link ChainClient} over a started config, owning one of its holds. */
function chainClientOver<TChains extends Record<string, ChainDefinition>>(
    built: BuiltConfig,
    fingerprint: string,
    entry: ConfigEntry,
): ChainClient<TChains> {
    let destroyed = false;
    return {
        ...built.apis,
        raw: built.raw,
        destroy() {
            // Each caller gives back its hold once, however often it calls this.
            if (destroyed) return;
            destroyed = true;
            entry.callers -= 1;
            if (entry.callers > 0) return;
            // `destroyAll()` has already forgotten a config it removed, and a
            // later call may have started the same config again.
            if (clientInstances.get(fingerprint) === entry) clientInstances.delete(fingerprint);
            for (const { genesis, held } of built.chains) {
                if (held) releaseChain(genesis, held.shared);
            }
        },
    } as ChainClient<TChains>;
}

type AcquiredChain = {
    name: string;
    descriptor: ChainDefinition;
    genesis: string;
    /** The chain's shared entry and client, or `null` for a chain the host can't serve. */
    held: { shared: SharedChain; client: PolkadotClient } | null;
    error: ChainNotSupportedError | undefined;
};

/* @integration */
async function initChainClient(config: ChainClientConfig<any>): Promise<BuiltConfig> {
    const names = Object.keys(config.chains);

    // Acquire every chain, waiting for all of them even when one fails: a hold
    // taken after a failure would otherwise never be given back.
    const outcomes = await Promise.allSettled(
        names.map(async (name): Promise<AcquiredChain> => {
            const descriptor = config.chains[name] as ChainDefinition;
            const genesis: string | undefined = descriptor.genesis;
            if (!genesis) {
                throw new Error(`Descriptor for chain "${name}" has no genesis hash.`);
            }
            try {
                const held = await acquireChain(genesis);
                return { name, descriptor, genesis, held, error: undefined };
            } catch (err) {
                // A chain the host can't serve must not tank the whole multi-chain
                // client — the supported chains stay usable, and this one surfaces a
                // clear error on first use instead of hanging. Any other failure
                // (e.g. not inside a container) is a hard error and still rejects.
                if (err instanceof ChainNotSupportedError) {
                    log.warn(
                        `Chain "${name}" is not supported by the host; its API will throw on use.`,
                        { genesis },
                    );
                    return { name, descriptor, genesis, held: null, error: err };
                }
                throw err;
            }
        }),
    );

    const entries: AcquiredChain[] = [];
    for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") entries.push(outcome.value);
    }
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) {
        // Give back only what this call took. A chain another config holds
        // stays open for it.
        for (const { genesis, held } of entries) {
            if (held) releaseChain(genesis, held.shared);
        }
        throw failure.reason;
    }

    // Build typed APIs and raw client map. Unsupported chains get a stand-in
    // whose access throws the original ChainNotSupportedError.
    const apis = {} as Record<string, unknown>;
    const raw = {} as Record<string, PolkadotClient>;

    for (const { name, descriptor, held, error } of entries) {
        if (held) {
            apis[name] = typedApi(held.shared, held.client, descriptor);
            raw[name] = held.client;
        } else {
            const api = unsupportedChainApi(error as ChainNotSupportedError);
            apis[name] = api;
            raw[name] = api as unknown as PolkadotClient;
        }
    }

    return { apis, raw, chains: entries };
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
 * Either way it is the product's one client for the chain, shared by every
 * `ChainClient` that includes it, so don't call `.destroy()` on it directly.
 *
 * @throws If the chain has not been connected, or is still connecting.
 */
export function getClient(descriptor: ChainDefinition): PolkadotClient {
    const genesis = descriptor.genesis;
    if (!genesis) throw new Error("Descriptor has no genesis hash.");
    const entry = getClientCache().get(genesis);
    if (!entry) {
        throw new Error(
            `Chain not connected (genesis: ${genesis}). Call createChainClient() first to establish connections.`,
        );
    }
    const client = readyClient(entry);
    if (!client) {
        throw new Error(
            `Chain not connected yet (genesis: ${genesis}). Await the createChainClient() call that is connecting it.`,
        );
    }
    return client;
}

/**
 * Check if a chain is currently connected.
 *
 * Synchronous — no side effects, no initialization.
 */
export function isConnected(descriptor: ChainDefinition): boolean {
    const genesis = descriptor.genesis;
    if (!genesis) return false;
    const entry = getClientCache().get(genesis);
    return entry !== undefined && readyClient(entry) !== undefined;
}

if (import.meta.vitest) {
    const { test, expect, beforeEach, vi } = import.meta.vitest;

    // Mock the provider + PAPI client factories so initChainClient can run without
    // a real host. vitest hoists these mocks into every test file that imports
    // this module, so they start out as the real functions and only the tests
    // here replace what they do.
    vi.mock("./providers.js", async (importOriginal) => {
        const actual = await importOriginal<typeof import("./providers.js")>();
        return { ...actual, createProvider: vi.fn(actual.createProvider) };
    });
    vi.mock("polkadot-api", async (importOriginal) => {
        const actual = await importOriginal<typeof import("polkadot-api")>();
        return { ...actual, createClient: vi.fn(actual.createClient) };
    });
    const { createProvider } = await import("./providers.js");

    type FakeClient = PolkadotClient & { destroyed: number; provider: unknown };

    /** A fake PAPI client that counts its destroys and remembers its provider. */
    function fakeClientFor(provider: unknown): FakeClient {
        const client = {
            provider,
            destroyed: 0,
            destroy() {
                client.destroyed += 1;
            },
            getTypedApi: (descriptor: ChainDefinition) => ({ descriptor }),
        };
        return client as unknown as FakeClient;
    }

    const people = { genesis: "0xpeople" } as ChainDefinition;
    const assetHub = { genesis: "0xassethub" } as ChainDefinition;
    const bulletin = { genesis: "0xbulletin" } as ChainDefinition;

    /** The providers handed out so far, by genesis, and how the fakes answer. */
    const providers = new Map<string, unknown[]>();
    const shared = (genesis: string) => getClientCache().get(genesis);

    beforeEach(() => {
        clearClientCache();
        clientInstances.clear();
        providers.clear();
        vi.mocked(createProvider).mockReset();
        vi.mocked(createClient).mockReset();
        vi.mocked(createProvider).mockImplementation(async (genesis: string) => {
            const provider = { genesis } as never;
            providers.set(genesis, [...(providers.get(genesis) ?? []), provider]);
            return provider;
        });
        vi.mocked(createClient).mockImplementation((provider) => fakeClientFor(provider));
    });

    const providersFor = (genesis: string) => providers.get(genesis) ?? [];
    const clientsFor = (genesis: string) =>
        vi
            .mocked(createClient)
            .mock.results.map((result) => result.value as FakeClient)
            .filter((client) => (client.provider as { genesis: string }).genesis === genesis);

    // --- one client per chain ---

    test("two configs sharing one chain create one provider and one client for it", async () => {
        const a = await createChainClient({ chains: { people, assetHub } });
        const b = await createChainClient({ chains: { people, bulletin } });

        expect(providersFor("0xpeople")).toHaveLength(1);
        expect(clientsFor("0xpeople")).toHaveLength(1);
        expect(a.raw.people).toBe(b.raw.people);
        expect(shared("0xpeople")?.users).toBe(2);
        // The chains only one config asks for are still each created once.
        expect(providersFor("0xassethub")).toHaveLength(1);
        expect(providersFor("0xbulletin")).toHaveLength(1);
    });

    test("two configs started concurrently on one chain end up with one client", async () => {
        const [a, b] = await Promise.all([
            createChainClient({ chains: { people, assetHub } }),
            createChainClient({ chains: { people, bulletin } }),
        ]);

        expect(providersFor("0xpeople")).toHaveLength(1);
        expect(clientsFor("0xpeople")).toHaveLength(1);
        expect(a.raw.people).toBe(b.raw.people);
        expect(shared("0xpeople")?.users).toBe(2);
    });

    test("a config's typed API for a chain is built once per descriptor over the shared client", async () => {
        const a = await createChainClient({ chains: { people } });
        const b = await createChainClient({ chains: { people, bulletin } });
        expect(a.people).toBe(b.people);
        expect(shared("0xpeople")?.api.get(people)).toBe(a.people);
    });

    // --- release ---

    test("destroying one config leaves the shared chain alive for the other, and the last destroy closes it once", async () => {
        const a = await createChainClient({ chains: { people, assetHub } });
        const b = await createChainClient({ chains: { people, bulletin } });
        const peopleClient = a.raw.people as FakeClient;

        a.destroy();
        expect(peopleClient.destroyed).toBe(0);
        expect(shared("0xpeople")?.users).toBe(1);
        expect(getClient(people)).toBe(b.raw.people);
        expect(isConnected(people)).toBe(true);
        // The chain only `a` used is gone.
        expect((a.raw.assetHub as FakeClient).destroyed).toBe(1);
        expect(isConnected(assetHub)).toBe(false);

        b.destroy();
        expect(peopleClient.destroyed).toBe(1);
        expect(isConnected(people)).toBe(false);
        expect(getClientCache().size).toBe(0);
        expect(clientInstances.size).toBe(0);
    });

    test("a config destroyed while another is still starting on the same chain leaves it alive", async () => {
        let resolveBulletin: (provider: never) => void = () => {};
        vi.mocked(createProvider).mockImplementation((genesis: string) =>
            genesis === "0xbulletin"
                ? new Promise<never>((resolve) => {
                      resolveBulletin = resolve;
                  })
                : Promise.resolve({ genesis } as never),
        );

        const a = await createChainClient({ chains: { people } });
        const pending = createChainClient({ chains: { people, bulletin } });
        await Promise.resolve();
        expect(shared("0xpeople")?.users).toBe(2);

        a.destroy();
        expect((a.raw.people as FakeClient).destroyed).toBe(0);

        resolveBulletin({ genesis: "0xbulletin" } as never);
        const b = await pending;
        expect(b.raw.people).toBe(a.raw.people);
        expect(getClient(people)).toBe(b.raw.people);
        b.destroy();
        expect((a.raw.people as FakeClient).destroyed).toBe(1);
    });

    test("destroy() twice on one ChainClient releases its hold once", async () => {
        const a = await createChainClient({ chains: { people } });
        const c = await createChainClient({ chains: { people, bulletin } });

        a.destroy();
        a.destroy();
        expect(shared("0xpeople")?.users).toBe(1);
        expect((c.raw.people as FakeClient).destroyed).toBe(0);
        expect(getClient(people)).toBe(c.raw.people);
    });

    test("a config that fails to start gives back the shared chain it took without closing it", async () => {
        vi.mocked(createProvider).mockImplementation(async (genesis: string) => {
            if (genesis === "0xboom") throw new Error("host gone");
            const provider = { genesis } as never;
            providers.set(genesis, [...(providers.get(genesis) ?? []), provider]);
            return provider;
        });
        const boom = { genesis: "0xboom" } as ChainDefinition;

        const a = await createChainClient({ chains: { people } });
        await expect(createChainClient({ chains: { people, boom } })).rejects.toThrow("host gone");

        expect((a.raw.people as FakeClient).destroyed).toBe(0);
        expect(shared("0xpeople")?.users).toBe(1);
        expect(shared("0xboom")).toBeUndefined();
        expect(getClient(people)).toBe(a.raw.people);
        // The failed config is forgotten, so asking again starts over.
        expect(clientInstances.size).toBe(1);
        await expect(createChainClient({ chains: { people, boom } })).rejects.toThrow("host gone");
        expect(shared("0xpeople")?.users).toBe(1);
    });

    test("a chain whose creation fails is retried by the next config asking for it", async () => {
        let attempts = 0;
        vi.mocked(createProvider).mockImplementation(async (genesis: string) => {
            attempts += 1;
            if (attempts === 1) throw new Error("not yet");
            return { genesis } as never;
        });

        await expect(createChainClient({ chains: { people } })).rejects.toThrow("not yet");
        expect(shared("0xpeople")).toBeUndefined();

        const a = await createChainClient({ chains: { people } });
        expect(attempts).toBe(2);
        expect(getClient(people)).toBe(a.raw.people);
    });

    test("two configs racing for a chain whose creation fails both give back their hold", async () => {
        vi.mocked(createProvider).mockImplementation(async (genesis: string) => {
            await Promise.resolve();
            throw new Error(`no ${genesis}`);
        });

        const results = await Promise.allSettled([
            createChainClient({ chains: { people } }),
            createChainClient({ chains: { people, bulletin } }),
        ]);
        expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
        expect(shared("0xpeople")).toBeUndefined();
        expect(getClientCache().size).toBe(0);
        expect(clientInstances.size).toBe(0);
    });

    test("destroyAll() while a chain is being created rejects the config and closes the client once", async () => {
        let resolveProvider: (provider: never) => void = () => {};
        vi.mocked(createProvider).mockImplementation(
            () =>
                new Promise<never>((resolve) => {
                    resolveProvider = resolve;
                }),
        );
        const pending = createChainClient({ chains: { people } });
        await Promise.resolve();
        destroyAll();
        resolveProvider({ genesis: "0xpeople" } as never);

        await expect(pending).rejects.toThrow(/destroyed while connecting/);
        expect(clientsFor("0xpeople")[0]?.destroyed).toBe(1);
        expect(isConnected(people)).toBe(false);
        expect(getClientCache().size).toBe(0);
        expect(clientInstances.size).toBe(0);

        // The chain can be opened again afterwards.
        vi.mocked(createProvider).mockImplementation(
            async (genesis: string) => ({ genesis }) as never,
        );
        const client = await createChainClient({ chains: { people } });
        expect(getClient(people)).toBe(client.raw.people);
        expect((client.raw.people as FakeClient).destroyed).toBe(0);
    });

    // --- unsupported chains ---

    test("an unsupported chain gets the throwing stand-in and holds no shared entry", async () => {
        vi.mocked(createProvider).mockImplementation(async (genesis: string) => {
            if (genesis === "0xbad") throw new ChainNotSupportedError(genesis);
            return { genesis } as never;
        });
        const bad = { genesis: "0xbad" } as ChainDefinition;

        const client = (await createChainClient({ chains: { people, bad } })) as any;

        // The whole client still resolves; the supported chain is fully usable.
        expect(client.people).toBeDefined();
        expect(client.raw.people).toBe(getClient(people));
        // The unsupported chain surfaces the original error on use — no hang.
        expect(() => client.bad.query).toThrow(ChainNotSupportedError);
        expect(() => client.raw.bad.destroy).toThrow(ChainNotSupportedError);
        expect(shared("0xbad")).toBeUndefined();
        expect(isConnected(bad)).toBe(false);
        expect(() => getClient(bad)).toThrow(/Chain not connected/);

        client.destroy();
        expect(getClientCache().size).toBe(0);
    });

    // --- lookups ---

    test("getClient and isConnected resolve a chain by genesis, however it was named", async () => {
        const a = await createChainClient({ chains: { first: people } });
        const b = await createChainClient({ chains: { second: people } });
        expect(a.raw.first).toBe(b.raw.second);
        expect(getClient({ genesis: "0xpeople" } as ChainDefinition)).toBe(a.raw.first);
        expect(isConnected({ genesis: "0xpeople" } as ChainDefinition)).toBe(true);
    });

    test("a chain still being created is not yet connected", async () => {
        let resolveProvider: (provider: never) => void = () => {};
        vi.mocked(createProvider).mockImplementation(
            () =>
                new Promise<never>((resolve) => {
                    resolveProvider = resolve;
                }),
        );
        const pending = createChainClient({ chains: { people } });
        await Promise.resolve();
        expect(shared("0xpeople")).toBeDefined();
        expect(isConnected(people)).toBe(false);
        expect(() => getClient(people)).toThrow(/not connected yet/);

        resolveProvider({ genesis: "0xpeople" } as never);
        const client = await pending;
        expect(isConnected(people)).toBe(true);
        expect(getClient(people)).toBe(client.raw.people);
    });

    test("isConnected returns false for unknown chain", () => {
        expect(isConnected(people)).toBe(false);
    });

    test("isConnected returns false for descriptor without genesis", () => {
        expect(isConnected({} as ChainDefinition)).toBe(false);
    });

    test("getClient throws for unconnected chain", () => {
        expect(() => getClient(people)).toThrow(/Chain not connected/);
    });

    test("getClient throws for descriptor without genesis", () => {
        expect(() => getClient({} as ChainDefinition)).toThrow(/no genesis hash/);
    });

    // --- destroyAll ---

    test("destroyAll closes every shared client and clears both caches", async () => {
        const a = await createChainClient({ chains: { people, assetHub } });
        const b = await createChainClient({ chains: { people, bulletin } });

        destroyAll();

        for (const client of [a.raw.people, a.raw.assetHub, b.raw.bulletin] as FakeClient[]) {
            expect(client.destroyed).toBe(1);
        }
        expect(isConnected(people)).toBe(false);
        expect(() => getClient(people)).toThrow(/Chain not connected/);
        expect(getClientCache().size).toBe(0);
        expect(clientInstances.size).toBe(0);

        // A client destroyed after destroyAll does not close the chain twice,
        // nor a chain a later config has since opened.
        const c = await createChainClient({ chains: { people } });
        a.destroy();
        b.destroy();
        expect((a.raw.people as FakeClient).destroyed).toBe(1);
        expect((c.raw.people as FakeClient).destroyed).toBe(0);
        expect(getClient(people)).toBe(c.raw.people);
    });

    test("a client destroyAll() tore down does not forget the same config a later call started", async () => {
        const a = await createChainClient({ chains: { people } });
        destroyAll();
        const c = await createChainClient({ chains: { people } });

        a.destroy();
        expect(clientInstances.size).toBe(1);
        const d = await createChainClient({ chains: { people } });
        expect(d.raw.people).toBe(c.raw.people);
        expect(shared("0xpeople")?.users).toBe(1);

        c.destroy();
        expect((c.raw.people as FakeClient).destroyed).toBe(0);
        d.destroy();
        expect((c.raw.people as FakeClient).destroyed).toBe(1);
        expect(clientInstances.size).toBe(0);
    });

    // --- config-level cache ---

    test("createChainClient with the same config twice shares its typed APIs, raw clients and one hold", async () => {
        const a = await createChainClient({ chains: { a: people } });
        const b = await createChainClient({ chains: { a: people } });
        expect(a.a).toBe(b.a);
        expect(a.raw.a).toBe(b.raw.a);
        expect(clientsFor("0xpeople")).toHaveLength(1);
        expect(shared("0xpeople")?.users).toBe(1);
        expect(clientInstances.size).toBe(1);
    });

    test("createChainClient deduplicates concurrent calls", async () => {
        const [a, b] = await Promise.all([
            createChainClient({ chains: { x: people } }),
            createChainClient({ chains: { x: people } }),
        ]);
        expect(a.x).toBe(b.x);
        expect(a.raw.x).toBe(b.raw.x);
        expect(clientsFor("0xpeople")).toHaveLength(1);
        expect(shared("0xpeople")?.users).toBe(1);
    });

    test("each caller with the same config owns its own hold, so destroying one keeps the chain for the other", async () => {
        const a = await createChainClient({ chains: { people } });
        const b = await createChainClient({ chains: { people } });

        a.destroy();
        a.destroy();
        expect((b.raw.people as FakeClient).destroyed).toBe(0);
        expect(getClient(people)).toBe(b.raw.people);
        expect(clientInstances.size).toBe(1);

        b.destroy();
        expect((b.raw.people as FakeClient).destroyed).toBe(1);
        expect(clientInstances.size).toBe(0);
        expect(getClientCache().size).toBe(0);
    });

    test("a caller that destroys its client before another call for the same config resolves leaves the chain open", async () => {
        const first = createChainClient({ chains: { people } });
        const second = createChainClient({ chains: { people } });
        const a = await first;
        a.destroy();
        const b = await second;
        expect((b.raw.people as FakeClient).destroyed).toBe(0);
        expect(getClient(people)).toBe(b.raw.people);
        b.destroy();
        expect((b.raw.people as FakeClient).destroyed).toBe(1);
    });

    test("createChainClient returns different results for different configs", async () => {
        const a = await createChainClient({ chains: { a: people } });
        const b = await createChainClient({ chains: { b: assetHub } });
        expect(a).not.toBe(b);
    });

    test("a descriptor without a genesis hash rejects the config", async () => {
        await expect(
            createChainClient({ chains: { people, nameless: {} as ChainDefinition } }),
        ).rejects.toThrow(/no genesis hash/);
        expect(shared("0xpeople")).toBeUndefined();
        expect(clientInstances.size).toBe(0);
    });

    // --- configFingerprint ---

    test("configFingerprint is stable regardless of key order", () => {
        const d1 = { genesis: "0x1" } as ChainDefinition;
        const d2 = { genesis: "0x2" } as ChainDefinition;
        expect(configFingerprint({ a: d1, b: d2 })).toBe(configFingerprint({ b: d2, a: d1 }));
    });
}
