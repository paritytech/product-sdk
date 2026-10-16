// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { useQueryClient } from "@tanstack/vue-query";
import {
    type ContactPickOutcome,
    type HostChainDiscovery,
    type HostChainIdentifier,
    type HostConnectionStatus,
    type HostInfo,
    type HostMode,
    type LocaleState,
    type ProductContext,
    type ThemeState,
    queryKeys,
} from "@parity/product-sdk-hooks-core";
import { type ComputedRef, type ShallowRef, computed } from "vue";
import { useRuntime } from "../context.js";
import {
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    type QueryResult,
    dropMutate,
    toGetter,
    useLiveQuery,
    useStore,
    useTruapiMutation,
    useTruapiQuery,
} from "../internal.js";

type HostController = ReturnType<typeof useRuntime>["host"];

/** `"unknown"` until async detection resolves, then `"host"` | `"standalone"`. */
export function useHostMode(): ShallowRef<HostMode> {
    return useStore(useRuntime().host.mode);
}

/** False while detection is pending — gate host-only UI on `useHostMode()` if the distinction matters. */
export function useIsHost(): ComputedRef<boolean> {
    const mode = useHostMode();
    return computed(() => mode.value === "host");
}

/** Live theme: host theme when embedded, `prefers-color-scheme` standalone. */
export function useTheme(): ShallowRef<ThemeState> {
    return useStore(useRuntime().theme);
}

/** Live host language (BCP 47 tag) when embedded, `navigator.language` standalone. */
export function useLocale(): ShallowRef<LocaleState> {
    return useStore(useRuntime().locale);
}

/** Host-channel transport status: `"connecting" | "connected" | "disconnected"` (always disconnected standalone). */
export function useHostConnectionStatus(): ShallowRef<HostConnectionStatus> {
    return useStore(useRuntime().host.connectionStatus);
}

/** Host identity and version (`System.host_info`); `null` standalone or on hosts that predate it. */
export function useHostInfo(options?: {
    query?: QueryOptions<HostInfo | null>;
}): QueryResult<HostInfo | null> {
    const runtime = useRuntime();
    return useTruapiQuery(
        () => queryKeys.hostInfo(),
        () => runtime.host.getInfo(),
        options,
    );
}

/** The canonical product id the host bound this app to; `null` standalone or on legacy hosts. */
export function useProductContext(options?: {
    query?: QueryOptions<ProductContext | null>;
}): QueryResult<ProductContext | null> {
    const runtime = useRuntime();
    return useTruapiQuery(
        () => queryKeys.productContext(),
        () => runtime.host.getProductContext(),
        options,
    );
}

/**
 * RFC-0026 chain discovery: the host's network name plus the genesis hash of
 * each requested role (`"Relay" | "AssetHub" | "People" | "Bulletin"`) it
 * serves. `null` standalone, on legacy hosts, or when none of the roles is served.
 */
export function useHostChainInfo(
    identifiers: MaybeGetter<readonly HostChainIdentifier[]>,
    options?: { query?: QueryOptions<HostChainDiscovery | null> },
): QueryResult<HostChainDiscovery | null> {
    const runtime = useRuntime();
    const get = toGetter(identifiers);
    return useTruapiQuery(
        () => queryKeys.hostChainInfo(get()),
        () => runtime.host.getChainInfo(get()),
        options,
    );
}

/**
 * Open the host's contact picker: `pick()` resolves a `ContactPickOutcome` —
 * `{ tag: "Picked", value: { handle } }` with an opaque handle the host later
 * resolves to the person's account, or `Dismissed` / `NoContacts` as data.
 * The product never sees the contact list. Host-only: standalone (and on hosts
 * without a picker) `pick` rejects with `HostUnavailableError`.
 */
export function usePickContact(options?: {
    mutation?: MutationOptions<ContactPickOutcome, void>;
}): NamedMutation<ContactPickOutcome, void> & { pick: () => Promise<ContactPickOutcome> } {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(() => runtime.host.pickContact(), options?.mutation);
    return {
        ...dropMutate(mutation),
        pick: () => mutation.mutateAsync(),
    };
}

export interface WorkerOperationApi {
    /** Open a pending operation the host keeps the worker alive for; resolves its id. */
    begin: (label?: string) => Promise<number>;
    /** Close an operation. Idempotent. */
    end: (id: number) => Promise<void>;
    /** Run `work` inside an operation, ending it however `work` settles. */
    run: <T>(work: () => Promise<T>, label?: string) => Promise<T>;
}

/**
 * Worker-lifecycle bookkeeping for products that run as a background
 * `Worker`: wrap long-running work in an operation so the host does not stop
 * the runtime mid-way. Host-only; every call rejects with
 * `HostUnavailableError` standalone.
 */
export function useWorkerOperation(): WorkerOperationApi {
    const runtime = useRuntime();
    const begin = (label?: string) => runtime.host.worker.beginOperation(label);
    const end = (id: number) => runtime.host.worker.endOperation(id);
    return {
        begin,
        end,
        run: async <T>(work: () => Promise<T>, label?: string): Promise<T> => {
            const id = await begin(label);
            try {
                return await work();
            } finally {
                await end(id).catch(() => {});
            }
        },
    };
}

/** RFC-0002 remote permissions (ChainSubmit, StatementSubmit, Remote domains, …): `request(permission)`. */
export function usePermission(options?: {
    mutation?: MutationOptions<boolean, Parameters<HostController["requestPermission"]>[0]>;
}): NamedMutation<boolean, Parameters<HostController["requestPermission"]>[0]> & {
    request: (permission: Parameters<HostController["requestPermission"]>[0]) => Promise<boolean>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (permission: Parameters<HostController["requestPermission"]>[0]) =>
            runtime.host.requestPermission(permission),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        request: (permission) => mutation.mutateAsync(permission),
    };
}

/** Device permissions (Camera, Notifications, Clipboard, …): `request(kind)`. */
export function useDevicePermission(options?: {
    mutation?: MutationOptions<boolean, Parameters<HostController["requestDevicePermission"]>[0]>;
}): NamedMutation<boolean, Parameters<HostController["requestDevicePermission"]>[0]> & {
    request: (kind: Parameters<HostController["requestDevicePermission"]>[0]) => Promise<boolean>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (kind: Parameters<HostController["requestDevicePermission"]>[0]) =>
            runtime.host.requestDevicePermission(kind),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        request: (kind) => mutation.mutateAsync(kind),
    };
}

type ResourceAllocationResult = Awaited<ReturnType<HostController["requestResourceAllocation"]>>;

/** RFC-0010 allowances (StatementStoreAllowance, AutoSigning, …), one prompt up front: `request(resources)`. */
export function useResourceAllocation(options?: {
    mutation?: MutationOptions<
        ResourceAllocationResult,
        Parameters<HostController["requestResourceAllocation"]>[0]
    >;
}): NamedMutation<
    ResourceAllocationResult,
    Parameters<HostController["requestResourceAllocation"]>[0]
> & {
    request: (
        resources: Parameters<HostController["requestResourceAllocation"]>[0],
    ) => Promise<ResourceAllocationResult>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (resources: Parameters<HostController["requestResourceAllocation"]>[0]) =>
            runtime.host.requestResourceAllocation(resources),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        request: (resources) => mutation.mutateAsync(resources),
    };
}

/** Host deep-link navigation: `.dot` routes in-container, `https://` external. */
export function useHostNavigate(): (url: string) => Promise<void> {
    const runtime = useRuntime();
    return (url) => runtime.host.navigate(url);
}

export function useFeatureSupported(
    feature: MaybeGetter<Parameters<HostController["featureSupported"]>[0] | undefined>,
    options?: { query?: QueryOptions<boolean> },
): QueryResult<boolean> {
    const runtime = useRuntime();
    const get = toGetter(feature);
    return useTruapiQuery(
        () => queryKeys.featureSupported(get()),
        () => {
            const value = get();
            return value ? runtime.host.featureSupported(value) : Promise.resolve(false);
        },
        options,
    );
}

/** RFC-0007 deterministic entropy — same key, same wallet ⇒ same 32 bytes: `derive(key)`. */
export function useDeriveEntropy(options?: {
    mutation?: MutationOptions<Uint8Array, Uint8Array>;
}): NamedMutation<Uint8Array, Uint8Array> & {
    derive: (key: Uint8Array) => Promise<Uint8Array>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (key: Uint8Array) => runtime.host.deriveEntropy(key),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        derive: (key: Uint8Array) => mutation.mutateAsync(key),
    };
}

type NotificationId = Awaited<ReturnType<HostController["pushNotification"]>>;

export interface NotificationsApi
    extends NamedMutation<NotificationId, Parameters<HostController["pushNotification"]>[0]> {
    push: (input: Parameters<HostController["pushNotification"]>[0]) => Promise<NotificationId>;
    cancel: (id: NotificationId) => Promise<void>;
}

/** RFC-0019 scheduled push notifications (host-only; throws HostUnavailableError standalone). */
export function useNotifications(): NotificationsApi {
    const runtime = useRuntime();
    const mutation = useTruapiMutation((input: Parameters<HostController["pushNotification"]>[0]) =>
        runtime.host.pushNotification(input),
    );
    return {
        ...dropMutate(mutation),
        push: (input) => mutation.mutateAsync(input),
        cancel: (id) => runtime.host.cancelNotification(id),
    };
}

export type HostStorageValue<T> = QueryResult<T | null> & {
    set: (value: T) => Promise<void>;
    remove: () => Promise<void>;
};

/**
 * Product-scoped KV storage, live: host localStorage inside a container
 * (`LocalStorage.subscribe`, so writes from the product's other runtimes show
 * up), browser localStorage standalone (following the cross-tab `storage`
 * event). JSON-serialized. Writes update the query cache in place under
 * `queryKeys.hostStorage(key)`.
 */
export function useHostStorage<T>(
    key: MaybeGetter<string>,
    options?: { query?: QueryOptions<T | null> },
): HostStorageValue<T> {
    const runtime = useRuntime();
    const queryClient = useQueryClient();
    const getKey = toGetter(key);
    const data = useLiveQuery<T | null>({
        queryKey: () => queryKeys.hostStorage(getKey()),
        attach: (onValue, onError) =>
            runtime.host.storage.watch(
                getKey(),
                (raw) => onValue(raw === null ? null : (JSON.parse(raw) as T)),
                { onError },
            ),
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
    return Object.assign({}, data, {
        set: async (value: T) => {
            await runtime.host.storage.setJSON(getKey(), value);
            queryClient.setQueryData(queryKeys.hostStorage(getKey()), value);
        },
        remove: async () => {
            await runtime.host.storage.remove(getKey());
            queryClient.setQueryData(queryKeys.hostStorage(getKey()), null);
        },
    }) as HostStorageValue<T>;
}
