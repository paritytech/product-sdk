// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type QueryClient,
    type UseMutationOptions,
    type UseMutationReturnType,
    type UseQueryOptions,
    type UseQueryReturnType,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/vue-query";
import {
    type LiveAttach,
    type LiveRegistry,
    type ReadonlyStore,
    createLiveRegistry,
    hashQueryKey,
    toError,
} from "@parity/product-sdk-hooks-core";
import {
    type ShallowRef,
    computed,
    onScopeDispose,
    shallowRef,
    toValue,
    watch as vueWatch,
} from "vue";

export function useStore<T>(store: ReadonlyStore<T>): ShallowRef<T> {
    const state = shallowRef(store.get());
    const stop = store.subscribe((value) => {
        state.value = value;
    });
    onScopeDispose(stop);
    return state;
}

export type MaybeGetter<T> = T | (() => T);
export const toGetter = <T>(value: MaybeGetter<T>): (() => T) =>
    typeof value === "function" ? (value as () => T) : () => value;

/** TanStack Query options accepted by every read composable via `query`. */
export type QueryOptions<T> = Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">;

/** TanStack Mutation options accepted by every mutation composable via `mutation`. */
export type MutationOptions<TData, TVariables> = Omit<
    UseMutationOptions<TData, Error, TVariables, unknown>,
    "mutationFn"
>;

/** Mutation variables that may be omitted entirely so the named action can be called bare. */
// biome-ignore lint/suspicious/noConfusingVoidType: void is what lets the action be called bare
export type OptionalVariables<T> = T | void;

export type QueryResult<T> = UseQueryReturnType<T, Error>;
export type MutationResult<TData, TVariables> = UseMutationReturnType<
    TData,
    Error,
    TVariables,
    unknown
>;

/**
 * Mutation state without the generic `mutate`/`mutateAsync` — every mutation
 * composable exposes a named action instead (`connect`, `upload`, `publish`, …).
 */
export type NamedMutation<TData, TVariables> = Omit<
    MutationResult<TData, TVariables>,
    "mutate" | "mutateAsync"
>;

export function dropMutate<TData, TVariables>(
    mutation: MutationResult<TData, TVariables>,
): NamedMutation<TData, TVariables> {
    const { mutate: _mutate, mutateAsync: _mutateAsync, ...state } = mutation;
    return state;
}

function mergedEnabled<T>(gate: () => boolean, query?: QueryOptions<T>): boolean {
    if (gate() === false) return false;
    const user = (query as { enabled?: unknown } | undefined)?.enabled;
    return user === undefined ? true : toValue(user) !== false;
}

/** `useQuery` over a reactive key: pass getters for anything that can change. */
export function useTruapiQuery<T>(
    queryKey: () => readonly unknown[],
    queryFn: () => Promise<T>,
    options?: { enabled?: MaybeGetter<boolean>; query?: QueryOptions<T> },
): QueryResult<T> {
    const gate = toGetter(options?.enabled ?? true);
    return useQuery(
        computed(() => ({
            ...(options?.query as object),
            queryKey: queryKey() as unknown[],
            queryFn,
            enabled: mergedEnabled(gate, options?.query),
        })) as never,
    ) as QueryResult<T>;
}

/** `useMutation` for a core action. */
export function useTruapiMutation<TVariables, TData>(
    mutationFn: (variables: TVariables) => Promise<TData>,
    options?: MutationOptions<TData, TVariables>,
): MutationResult<TData, TVariables> {
    return useMutation({
        ...(options as object),
        mutationFn,
    }) as MutationResult<TData, TVariables>;
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
    queryKey: () => readonly unknown[];
    attach: LiveAttach<TIn>;
    /** Fold an incoming value into the cached one (list accumulation). Default: replace. */
    reduce?: (prev: TData | undefined, incoming: TIn) => TData;
    /** When set, the query settles with this value immediately instead of awaiting the first push. */
    seed?: () => TData;
    enabled?: MaybeGetter<boolean>;
    query?: QueryOptions<TData>;
}

/**
 * Bridge a core `watch*` subscription into the query cache: values land via
 * `setQueryData` under the key (visible to devtools / other readers), the
 * underlying subscription is shared per key, and errors surface on the
 * result while the last data is retained.
 */
export function useLiveQuery<TIn, TData = TIn>(
    config: LiveQueryConfig<TIn, TData>,
): QueryResult<TData> {
    const client = useQueryClient();
    const enabled = toGetter(config.enabled ?? true);
    const keyHash = computed(() => hashQueryKey(config.queryKey()));
    const subError = shallowRef<Error | undefined>(undefined);

    vueWatch(
        [keyHash, enabled],
        (_next, _prev, onCleanup) => {
            subError.value = undefined;
            if (!enabled()) return;
            const key = config.queryKey();
            const release = registryFor(client).acquire<TIn>(
                hashQueryKey(key),
                (onValue, onError) => config.attach(onValue, onError),
                (incoming) => {
                    if (config.reduce) {
                        client.setQueryData(
                            key,
                            config.reduce(client.getQueryData(key) as TData | undefined, incoming),
                        );
                    } else {
                        client.setQueryData(key, incoming as unknown as TData);
                    }
                },
                (error) => {
                    subError.value = toError(error);
                },
            );
            onCleanup(release);
        },
        { immediate: true },
    );

    const result = useQuery(
        computed(() => ({
            staleTime: Number.POSITIVE_INFINITY,
            ...(config.query as object),
            queryKey: config.queryKey() as unknown[],
            queryFn: async ({ signal }: { signal: AbortSignal }) => {
                const key = config.queryKey();
                if (config.seed)
                    return (client.getQueryData(key) as TData | undefined) ?? config.seed();
                await registryFor(client).first<TIn>(hashQueryKey(key), signal);
                // The cache may already hold newer pushes; never move it backwards.
                return client.getQueryData(key) as TData;
            },
            retry: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            enabled: mergedEnabled(enabled, config.query),
        })) as never,
    ) as QueryResult<TData>;

    // Subscription errors keep the last data (matching pre-0.2 behavior) but
    // flip the result into the error state.
    return {
        ...result,
        status: computed(() => (subError.value ? "error" : result.status.value)),
        error: computed(() => subError.value ?? result.error.value),
        isError: computed(() => subError.value !== undefined || result.isError.value),
        isSuccess: computed(() => subError.value === undefined && result.isSuccess.value),
        isPending: computed(() => subError.value === undefined && result.isPending.value),
    } as QueryResult<TData>;
}

export type LiveListQueryResult<T> = QueryResult<T[]> & { clear: () => void };

/** `useLiveQuery` specialization that accumulates pushed values into a bounded list. */
export function useLiveListQuery<T>(config: {
    queryKey: () => readonly unknown[];
    attach: LiveAttach<T>;
    limit?: number;
    enabled?: MaybeGetter<boolean>;
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
    return Object.assign({}, result, {
        clear: () => client.setQueryData(config.queryKey(), []),
    }) as LiveListQueryResult<T>;
}
