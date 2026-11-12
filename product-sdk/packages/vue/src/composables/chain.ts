// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type AccountBalance,
    type PolkadotClient,
    type TypedApiOf,
    queryKeys,
    resolveChain,
} from "@parity/product-sdk-hooks-core";
import { type ChainKey, type ResolvedChains, useRuntime } from "../context.js";
import {
    type MaybeGetter,
    type QueryOptions,
    type QueryResult,
    toGetter,
    useLiveQuery,
    useTruapiQuery,
} from "../internal.js";

export interface ChainScope<K extends ChainKey = ChainKey> {
    chain?: K;
}

/** The raw PAPI client — escape hatch for anything the composables don't cover. */
export function useChainClient(
    options?: ChainScope & { query?: QueryOptions<PolkadotClient> },
): QueryResult<PolkadotClient> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useTruapiQuery(
        () => queryKeys.chainClient(chainKey),
        () => runtime.chains.getClient(options?.chain),
        options,
    );
}

/** The descriptor-typed PAPI api for a configured chain. */
export function useTypedApi<K extends ChainKey>(
    options?: ChainScope<K> & { query?: QueryOptions<TypedApiOf<ResolvedChains, K>> },
): QueryResult<TypedApiOf<ResolvedChains, K>> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useTruapiQuery(
        () => queryKeys.typedApi(chainKey),
        () => runtime.chains.getTypedApi(options?.chain) as Promise<TypedApiOf<ResolvedChains, K>>,
        options,
    );
}

/**
 * One-shot read against the typed api, cached under
 * `queryKeys.chainQuery(chain, deps)`. Pass getters in `deps` for reactive
 * inputs — they become part of the query key, so the read re-runs (and
 * caches separately) when they change.
 */
export function useChainQuery<T, K extends ChainKey = ChainKey>(
    read: (api: TypedApiOf<ResolvedChains, K>) => Promise<T>,
    deps: readonly MaybeGetter<unknown>[] = [],
    options?: ChainScope<K> & { enabled?: MaybeGetter<boolean>; query?: QueryOptions<T> },
): QueryResult<T> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useTruapiQuery(
        () =>
            queryKeys.chainQuery(
                chainKey,
                deps.map((dep) => toGetter(dep)()),
            ),
        async () => {
            const api = (await runtime.chains.getTypedApi(options?.chain)) as TypedApiOf<
                ResolvedChains,
                K
            >;
            return read(api);
        },
        options,
    );
}

/**
 * Live subscription to any typed-api observable (storage watch, events, …);
 * one shared subscription per key, values bridged into the query cache,
 * torn down when the last consumer's scope disposes.
 */
export function useChainSubscription<T, K extends ChainKey = ChainKey>(
    select: (
        api: TypedApiOf<ResolvedChains, K>,
        client: PolkadotClient,
    ) => {
        subscribe(observer: { next: (v: T) => void; error?: (e: unknown) => void }): {
            unsubscribe(): void;
        };
    },
    deps: readonly MaybeGetter<unknown>[] = [],
    options?: ChainScope<K> & { enabled?: MaybeGetter<boolean>; query?: QueryOptions<T> },
): QueryResult<T> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useLiveQuery<T>({
        queryKey: () =>
            queryKeys.chainSubscription(
                chainKey,
                deps.map((dep) => toGetter(dep)()),
            ),
        attach: (onValue, onError) =>
            runtime.chains.watch<T, K>(select as never, onValue, {
                ...(options?.chain !== undefined ? { chain: options.chain } : {}),
                onError,
            }),
        enabled: options?.enabled ?? true,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

/** Best-block number, live. */
export function useBlockNumber(
    options?: ChainScope & { enabled?: MaybeGetter<boolean>; query?: QueryOptions<number> },
): QueryResult<number> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useLiveQuery<number>({
        queryKey: () => queryKeys.blockNumber(chainKey),
        attach: (onValue, onError) =>
            runtime.chains.watchBlockNumber(onValue, {
                ...(options?.chain !== undefined ? { chain: options.chain } : {}),
                onError,
            }),
        enabled: options?.enabled ?? true,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

/** Live native balance of `address` (free/reserved/frozen, in planck). */
export function useBalance(
    address: MaybeGetter<string | undefined>,
    options?: ChainScope & { query?: QueryOptions<AccountBalance> },
): QueryResult<AccountBalance> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    const getAddress = toGetter(address);
    return useLiveQuery<AccountBalance>({
        queryKey: () => queryKeys.balance(chainKey, getAddress() ?? null),
        attach: (onValue, onError) =>
            runtime.chains.watchBalance(getAddress() ?? "", onValue, {
                ...(options?.chain !== undefined ? { chain: options.chain } : {}),
                onError,
            }),
        enabled: () => getAddress() !== undefined,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

/** Chain name/properties as reported by the host (null standalone). */
export function useChainSpec(options?: ChainScope) {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useTruapiQuery(
        () => queryKeys.chainSpec(chainKey),
        async () => {
            const genesisHash = await runtime.chains.getGenesisHash(options?.chain);
            return genesisHash ? runtime.host.getChainSpec(genesisHash) : null;
        },
    );
}
