// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type QueryClient,
    type QueryKey,
    type UseMutationOptions,
    type UseMutationResult,
    type UseQueryOptions,
    type UseQueryResult,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import {
    type LiveAttach,
    type LiveRegistry,
    type ReadonlyStore,
    createLiveRegistry,
    hashQueryKey,
} from "@parity/product-sdk-hooks-core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

export function useStore<T>(store: ReadonlyStore<T>): T {
    const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
    return useSyncExternalStore(subscribe, store.get, store.get);
}

/** TanStack Query options accepted by every read hook via `query`. */
export type QueryOptions<T> = Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">;

/** TanStack Mutation options accepted by every mutation hook via `mutation`. */
export type MutationOptions<TData, TVariables> = Omit<
    UseMutationOptions<TData, Error, TVariables>,
    "mutationFn"
>;

/** Mutation variables that may be omitted entirely so the named action can be called bare. */
// biome-ignore lint/suspicious/noConfusingVoidType: void is what lets the action be called bare
export type OptionalVariables<T> = T | void;

/**
 * Mutation state without the generic `mutate`/`mutateAsync` — every mutation
 * hook exposes a named action instead (`connect`, `upload`, `publish`, …).
 */
export type NamedMutation<TData, TVariables> = Omit<
    UseMutationResult<TData, Error, TVariables>,
    "mutate" | "mutateAsync"
>;

export function dropMutate<TData, TVariables>(
    mutation: UseMutationResult<TData, Error, TVariables>,
): NamedMutation<TData, TVariables> {
    const { mutate: _mutate, mutateAsync: _mutateAsync, ...state } = mutation;
    return state;
}

/** `useQuery` with a stable identity for the hook-supplied fetcher. */
export function useTruapiQuery<T>(
    queryKey: QueryKey,
    queryFn: () => Promise<T>,
    options?: { enabled?: boolean; query?: QueryOptions<T> },
): UseQueryResult<T, Error> {
    const fnRef = useRef(queryFn);
    fnRef.current = queryFn;
    const gate = options?.enabled ?? true;
    return useQuery({
        ...options?.query,
        queryKey,
        queryFn: () => fnRef.current(),
        enabled: gate === false ? false : (options?.query?.enabled ?? true),
    });
}

/** `useMutation` with a stable identity for the hook-supplied action. */
export function useTruapiMutation<TVariables, TData>(
    mutationFn: (variables: TVariables) => Promise<TData>,
    options?: MutationOptions<TData, TVariables>,
): UseMutationResult<TData, Error, TVariables> {
    const fnRef = useRef(mutationFn);
    fnRef.current = mutationFn;
    return useMutation({
        ...options,
        mutationFn: (variables: TVariables) => fnRef.current(variables),
    });
}

// One live-subscription registry per QueryClient: subscriptions are shared
// across every component that mounts the same query key.
const registries = new WeakMap<QueryClient, LiveRegistry>();
function registryFor(client: QueryClient): LiveRegistry {
    let registry = registries.get(client);
    if (!registry) {
        registry = createLiveRegistry();
        registries.set(client, registry);
    }
    return registry;
}

export interface LiveQueryConfig<TIn, TData = TIn> {
    queryKey: QueryKey;
    attach: LiveAttach<TIn>;
    /** Fold an incoming value into the cached one (list accumulation). Default: replace. */
    reduce?: (prev: TData | undefined, incoming: TIn) => TData;
    /** When set, the query settles with this value immediately instead of awaiting the first push. */
    seed?: () => TData;
    enabled?: boolean;
    query?: QueryOptions<TData>;
}

/**
 * Bridge a core `watch*` subscription into the query cache: values land via
 * `setQueryData` under `queryKey` (visible to devtools / other readers), the
 * underlying subscription is shared per key, and errors surface on the
 * result while the last data is retained.
 */
export function useLiveQuery<TIn, TData = TIn>(
    config: LiveQueryConfig<TIn, TData>,
): UseQueryResult<TData, Error> {
    const client = useQueryClient();
    const { queryKey, enabled = true } = config;
    const hash = hashQueryKey(queryKey);
    const configRef = useRef(config);
    configRef.current = config;
    const [subError, setSubError] = useState<Error | undefined>(undefined);

    useEffect(() => {
        setSubError(undefined);
        if (!enabled) return;
        return registryFor(client).acquire<TIn>(
            hash,
            (onValue, onError) => configRef.current.attach(onValue, onError),
            (incoming) => {
                const { reduce, queryKey: key } = configRef.current;
                if (reduce) {
                    client.setQueryData(
                        key,
                        reduce(client.getQueryData(key) as TData | undefined, incoming),
                    );
                } else {
                    client.setQueryData(key, incoming as unknown as TData);
                }
            },
            setSubError,
        );
    }, [client, hash, enabled]);

    const result = useQuery({
        staleTime: Number.POSITIVE_INFINITY,
        ...config.query,
        queryKey,
        queryFn: async ({ signal }) => {
            const { seed } = configRef.current;
            if (seed) return (client.getQueryData(queryKey) as TData | undefined) ?? seed();
            await registryFor(client).first<TIn>(hash, signal);
            // The cache may already hold newer pushes; never move it backwards.
            return client.getQueryData(queryKey) as TData;
        },
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        enabled: enabled === false ? false : (config.query?.enabled ?? true),
    });

    return useMemo(() => {
        if (!subError) return result;
        // Subscription errors keep the last data (matching pre-0.2 behavior) but
        // flip the result into the error state.
        return {
            ...result,
            status: "error",
            error: subError,
            isError: true,
            isSuccess: false,
            isPending: false,
        } as UseQueryResult<TData, Error>;
    }, [result, subError]);
}

export type LiveListQueryResult<T> = UseQueryResult<T[], Error> & { clear: () => void };

/** `useLiveQuery` specialization that accumulates pushed values into a bounded list. */
export function useLiveListQuery<T>(config: {
    queryKey: QueryKey;
    attach: LiveAttach<T>;
    limit?: number;
    enabled?: boolean;
    query?: QueryOptions<T[]>;
}): LiveListQueryResult<T> {
    const client = useQueryClient();
    const limit = config.limit ?? 500;
    const result = useLiveQuery<T, T[]>({
        queryKey: config.queryKey,
        attach: config.attach,
        reduce: (prev, incoming) => [...(prev ?? []).slice(-(limit - 1)), incoming],
        seed: () => [],
        ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
        ...(config.query !== undefined ? { query: config.query } : {}),
    });
    const { queryKey } = config;
    const hash = hashQueryKey(queryKey);
    // biome-ignore lint/correctness/useExhaustiveDependencies: hash covers queryKey
    const clear = useCallback(() => client.setQueryData(queryKey, []), [client, hash]);
    return useMemo(() => Object.assign({}, result, { clear }), [result, clear]);
}
