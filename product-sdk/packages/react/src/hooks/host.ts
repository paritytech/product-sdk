// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
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
import { useCallback } from "react";
import { useRuntime } from "../context.js";
import {
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    dropMutate,
    useLiveQuery,
    useStore,
    useTruapiMutation,
    useTruapiQuery,
} from "../internal.js";

type HostController = ReturnType<typeof useRuntime>["host"];

/** `"unknown"` until async detection resolves, then `"host"` | `"standalone"`. */
export function useHostMode(): HostMode {
    return useStore(useRuntime().host.mode);
}

/** False while detection is pending — gate host-only UI on `useHostMode()` if the distinction matters. */
export function useIsHost(): boolean {
    return useHostMode() === "host";
}

/** Live theme: host theme when embedded, `prefers-color-scheme` standalone. */
export function useTheme(): ThemeState {
    return useStore(useRuntime().theme);
}

/** Live host language (BCP 47 tag) when embedded, `navigator.language` standalone. */
export function useLocale(): LocaleState {
    return useStore(useRuntime().locale);
}

/** Host-channel transport status: `"connecting" | "connected" | "disconnected"` (always disconnected standalone). */
export function useHostConnectionStatus(): HostConnectionStatus {
    return useStore(useRuntime().host.connectionStatus);
}

/** Host identity and version (`System.host_info`); `null` standalone or on hosts that predate it. */
export function useHostInfo(options?: {
    query?: QueryOptions<HostInfo | null>;
}): UseQueryResult<HostInfo | null, Error> {
    const runtime = useRuntime();
    return useTruapiQuery(queryKeys.hostInfo(), () => runtime.host.getInfo(), options);
}

/** The canonical product id the host bound this app to; `null` standalone or on legacy hosts. */
export function useProductContext(options?: {
    query?: QueryOptions<ProductContext | null>;
}): UseQueryResult<ProductContext | null, Error> {
    const runtime = useRuntime();
    return useTruapiQuery(
        queryKeys.productContext(),
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
    identifiers: readonly HostChainIdentifier[],
    options?: { query?: QueryOptions<HostChainDiscovery | null> },
): UseQueryResult<HostChainDiscovery | null, Error> {
    const runtime = useRuntime();
    return useTruapiQuery(
        queryKeys.hostChainInfo(identifiers),
        () => runtime.host.getChainInfo(identifiers),
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
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        pick: useCallback(() => mutateAsync(), [mutateAsync]),
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
    const begin = useCallback(
        (label?: string) => runtime.host.worker.beginOperation(label),
        [runtime],
    );
    const end = useCallback((id: number) => runtime.host.worker.endOperation(id), [runtime]);
    const run = useCallback(
        async <T>(work: () => Promise<T>, label?: string): Promise<T> => {
            const id = await begin(label);
            try {
                return await work();
            } finally {
                await end(id).catch(() => {});
            }
        },
        [begin, end],
    );
    return { begin, end, run };
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
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        request: useCallback((permission) => mutateAsync(permission), [mutateAsync]),
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
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        request: useCallback((kind) => mutateAsync(kind), [mutateAsync]),
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
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        request: useCallback((resources) => mutateAsync(resources), [mutateAsync]),
    };
}

/** Host deep-link navigation: `.dot` routes in-container, `https://` external. */
export function useHostNavigate(): (url: string) => Promise<void> {
    const runtime = useRuntime();
    return useCallback((url: string) => runtime.host.navigate(url), [runtime]);
}

export function useFeatureSupported(
    feature: Parameters<HostController["featureSupported"]>[0] | undefined,
    options?: { query?: QueryOptions<boolean> },
): UseQueryResult<boolean, Error> {
    const runtime = useRuntime();
    return useTruapiQuery(
        queryKeys.featureSupported(feature),
        () => (feature ? runtime.host.featureSupported(feature) : Promise.resolve(false)),
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
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        derive: useCallback((key: Uint8Array) => mutateAsync(key), [mutateAsync]),
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
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        push: useCallback((input) => mutateAsync(input), [mutateAsync]),
        cancel: useCallback((id) => runtime.host.cancelNotification(id), [runtime]),
    };
}

export type HostStorageValue<T> = UseQueryResult<T | null, Error> & {
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
    key: string,
    options?: { query?: QueryOptions<T | null> },
): HostStorageValue<T> {
    const runtime = useRuntime();
    const queryClient = useQueryClient();
    const queryKey = queryKeys.hostStorage(key);
    const data = useLiveQuery<T | null>({
        queryKey,
        attach: (onValue, onError) =>
            runtime.host.storage.watch(
                key,
                (raw) => onValue(raw === null ? null : (JSON.parse(raw) as T)),
                { onError },
            ),
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
    const set = useCallback(
        async (value: T) => {
            await runtime.host.storage.setJSON(key, value);
            queryClient.setQueryData(queryKeys.hostStorage(key), value);
        },
        [runtime, key, queryClient],
    );
    const remove = useCallback(async () => {
        await runtime.host.storage.remove(key);
        queryClient.setQueryData(queryKeys.hostStorage(key), null);
    }, [runtime, key, queryClient]);
    return { ...data, set, remove };
}
