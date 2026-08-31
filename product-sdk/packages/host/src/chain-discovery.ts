// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Host chain discovery. Resolves chain roles to genesis hashes against the
 * host's configured environment instead of hard-coding them.
 *
 * The wire method takes one identifier per call, so the facade fires one
 * concurrent call per requested identifier and caches the combined result
 * for the lifetime of the connection. Consumed internally by chain-client.
 * Products normally never call this directly.
 *
 * @module
 */

import type {
    ChainIdentifier,
    HexString,
    TrUApiClient,
    VersionedRemoteChainInfoError,
    scale,
} from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";
import { formatHostError } from "./errors.js";
import { getClient } from "./transport.js";

const log = createLogger("host");

/**
 * Chain-role identifier. A closed protocol enum, not a free-form name. The
 * host maps each role to the concrete chain of its configured environment.
 */
export type HostChainIdentifier = ChainIdentifier;

/** The host's configured environment plus per-identifier resolved genesis hashes. */
export interface HostChainDiscovery {
    /** Ecosystem the host is configured for, e.g. `"polkadot"`, `"paseo"`. */
    network: string;
    /** Present for every requested identifier the host serves. */
    chains: Partial<Record<HostChainIdentifier, HexString>>;
}

/** Error channel of `chain.getChainInfo`. */
type GetChainInfoError = scale.CallErrorValue<VersionedRemoteChainInfoError>;

/**
 * Marks a transient probe failure. These are evicted from the cache so the
 * next call re-probes. Stable "no discovery" answers stay cached.
 */
const TRANSIENT_FAILURE = Symbol("transient-failure");

/**
 * Hosts that predate the wire-id reservation never answer the probe at all,
 * so a silent host must resolve as "no discovery" instead of hanging. The
 * answer comes from host config with no chain I/O, so a short deadline is
 * enough. A timeout is treated as transient, never cached: a host that
 * supports discovery but started slowly would otherwise be recorded as
 * pre-discovery for the life of the client. The cost is that a genuinely
 * legacy host pays the deadline again on the next call.
 */
const PROBE_TIMEOUT_MS = 3_000;

const discoveryCache = new WeakMap<TrUApiClient, Map<string, Promise<HostChainDiscovery | null>>>();

/**
 * Resolve chain roles against the current host.
 *
 * Returns `null` when discovery is unavailable: outside a container, on a
 * legacy host, or when the host serves none of the requested identifiers.
 * Callers treat `null` as "fall back to configured constants".
 *
 * One concurrent `getChainInfo` call is made per identifier. Identifiers
 * the host answers `NotSupported` for are absent from `chains`. Stable
 * answers are cached per client and identifier set. Unexpected wire failures
 * and probe timeouts are logged, return `null` and are not cached, so a later
 * call re-probes.
 */
export async function getHostChainInfo(
    identifiers: readonly HostChainIdentifier[],
): Promise<HostChainDiscovery | null> {
    const client = await getClient();
    if (!client) return null;
    let bySet = discoveryCache.get(client);
    if (!bySet) {
        bySet = new Map();
        discoveryCache.set(client, bySet);
    }
    const key = [...identifiers].sort().join(",");
    let cached = bySet.get(key);
    if (!cached) {
        cached = fetchChainInfo(client, identifiers).then((result) => {
            if (result === TRANSIENT_FAILURE) {
                // Evict so the next caller re-probes.
                bySet.delete(key);
                return null;
            }
            return result;
        });
        bySet.set(key, cached);
    }
    return cached;
}

async function fetchChainInfo(
    client: TrUApiClient,
    identifiers: readonly HostChainIdentifier[],
): Promise<HostChainDiscovery | null | typeof TRANSIENT_FAILURE> {
    try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const probe = Promise.all(
            identifiers.map((id) =>
                client.chain.getChainInfo({ chain: id }).match(
                    (value) => ({ id, ok: value }) as const,
                    (error) => ({ id, err: error }) as const,
                ),
            ),
        );
        const outcomes = await Promise.race([
            probe,
            new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS);
            }),
        ]).finally(() => clearTimeout(timer));
        if (outcomes === "timeout") {
            log.warn("getChainInfo probe timed out, treating the host as pre-discovery for now");
            return TRANSIENT_FAILURE;
        }
        let network: string | undefined;
        const chains: Partial<Record<HostChainIdentifier, HexString>> = {};
        for (const outcome of outcomes) {
            if ("ok" in outcome) {
                network = outcome.ok.network;
                chains[outcome.id] = outcome.ok.genesisHash;
                continue;
            }
            // "Unsupported" means the host predates the method entirely.
            // "NotSupported" means this one identifier is not served.
            if (outcome.err.tag === "Unsupported") return null;
            if (isNotSupported(outcome.err)) continue;
            log.warn(`getChainInfo failed: ${formatHostError(outcome.err)}`);
            return TRANSIENT_FAILURE;
        }
        // Every identifier was refused, so the host never revealed its network.
        if (network === undefined) return null;
        return { network, chains };
    } catch (error) {
        log.warn(`getChainInfo failed: ${formatHostError(error)}`);
        return TRANSIENT_FAILURE;
    }
}

/** True when a domain error is the unit `NotSupported` variant. */
function isNotSupported(error: GetChainInfoError): boolean {
    return error.tag === "Domain" && error.value.value.tag === "NotSupported";
}

if (import.meta.vitest) {
    const { test, expect, afterEach, vi } = import.meta.vitest;
    const { setTruApiClient } = await import("./transport.js");
    type ChainInfoResponse = import("@parity/truapi").RemoteChainInfoResponse;

    type Served = Partial<Record<HostChainIdentifier, HexString>>;

    const NOT_SUPPORTED: GetChainInfoError = {
        tag: "Domain",
        value: { tag: "V1", value: { tag: "NotSupported" } },
    };

    type FakeBehavior = { network: string; served: Served } | { err: GetChainInfoError };

    /** Fake client answering from a served-chains map or a per-call behavior function. */
    function fakeClient(
        behavior: FakeBehavior | ((call: number) => FakeBehavior),
        calls: { count: number; requests: HostChainIdentifier[] } = { count: 0, requests: [] },
    ): TrUApiClient {
        return {
            chain: {
                getChainInfo: (request: { chain: HostChainIdentifier }) => {
                    const current =
                        typeof behavior === "function" ? behavior(calls.count) : behavior;
                    calls.count += 1;
                    calls.requests.push(request.chain);
                    return {
                        match: async <A, B>(
                            onOk: (v: ChainInfoResponse) => A,
                            onErr: (e: GetChainInfoError) => B,
                        ) => {
                            if ("err" in current) return onErr(current.err);
                            const genesisHash = current.served[request.chain];
                            if (!genesisHash) return onErr(NOT_SUPPORTED);
                            return onOk({
                                network: current.network,
                                chain: request.chain,
                                genesisHash,
                            });
                        },
                    };
                },
            },
        } as unknown as TrUApiClient;
    }

    const PASEO_SERVED: Served = {
        AssetHub: "0xaa" as HexString,
        Bulletin: "0xbb" as HexString,
        People: "0xcc" as HexString,
    };

    afterEach(() => {
        setTruApiClient(null);
        vi.restoreAllMocks();
    });

    test("resolves each requested identifier once, unserved ones absent", async () => {
        const calls = { count: 0, requests: [] as HostChainIdentifier[] };
        setTruApiClient(
            fakeClient({ network: "paseo", served: { AssetHub: "0xaa" as HexString } }, calls),
        );
        const result = await getHostChainInfo(["AssetHub", "Bulletin", "People"]);
        expect(result).toEqual({ network: "paseo", chains: { AssetHub: "0xaa" } });
        expect(calls.requests).toEqual(["AssetHub", "Bulletin", "People"]);
    });

    test("returns null when discovery is unavailable and caches the answer", async () => {
        // Outside a container.
        expect(await getHostChainInfo(["AssetHub"])).toBeNull();
        // Every identifier refused, so the network is never revealed.
        const refused = { count: 0, requests: [] as HostChainIdentifier[] };
        setTruApiClient(fakeClient({ network: "devnet", served: {} }, refused));
        expect(await getHostChainInfo(["Bulletin"])).toBeNull();
        expect(await getHostChainInfo(["Bulletin"])).toBeNull();
        expect(refused.count).toBe(1);
        // Legacy host answering Unsupported.
        const legacy = { count: 0, requests: [] as HostChainIdentifier[] };
        setTruApiClient(fakeClient({ err: { tag: "Unsupported" } }, legacy));
        expect(await getHostChainInfo(["AssetHub"])).toBeNull();
        expect(await getHostChainInfo(["AssetHub"])).toBeNull();
        expect(legacy.count).toBe(1);
    });

    test("caches per client and identifier set, ignoring order", async () => {
        const calls = { count: 0, requests: [] as HostChainIdentifier[] };
        setTruApiClient(fakeClient({ network: "paseo", served: PASEO_SERVED }, calls));
        await getHostChainInfo(["AssetHub", "Bulletin"]);
        await getHostChainInfo(["Bulletin", "AssetHub"]);
        expect(calls.count).toBe(2);
        await getHostChainInfo(["People"]);
        expect(calls.count).toBe(3);
    });

    test("a silent host times out to null and the next call re-probes", async () => {
        vi.useFakeTimers();
        try {
            const calls = { count: 0 };
            setTruApiClient({
                chain: {
                    getChainInfo: () => {
                        calls.count += 1;
                        return { match: () => new Promise(() => {}) };
                    },
                },
            } as unknown as TrUApiClient);
            const pending = getHostChainInfo(["AssetHub"]);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(await pending).toBeNull();
            // A host that merely started slowly must not stay classified as
            // pre-discovery, so the timeout is never cached.
            const retry = getHostChainInfo(["AssetHub"]);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(await retry).toBeNull();
            expect(calls.count).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    test("transient wire failures return null but are not cached, the next call re-probes", async () => {
        setTruApiClient(
            fakeClient((call) =>
                call === 0
                    ? { err: { tag: "HostFailure", value: { reason: "boom" } } }
                    : { network: "paseo", served: PASEO_SERVED },
            ),
        );
        expect(await getHostChainInfo(["AssetHub"])).toBeNull();
        expect((await getHostChainInfo(["AssetHub"]))?.network).toBe("paseo");
    });
}
