// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type AllocatableResource,
    type AllocationOutcome,
    type ChainSpec,
    type DevicePermissionKind,
    type Feature,
    type HostChainDiscovery,
    type HostChainIdentifier,
    type HostConnectionStatus,
    type HostError,
    HostUnavailableError,
    type NotificationId,
    type PushNotificationInput,
    type RemotePermissionItem,
    type Result,
    type TruApi,
    formatHostError,
    fromHex,
    getHostChainInfo,
    getHostLocalStorage,
    getNotificationManager,
    getTruApi,
    isInsideContainer,
    isInsideContainerSync,
    deriveEntropy as sdkDeriveEntropy,
    featureSupported as sdkFeatureSupported,
    getChainSpec as sdkGetChainSpec,
    isChainSupported as sdkIsChainSupported,
    navigateTo as sdkNavigateTo,
    requestDevicePermission as sdkRequestDevicePermission,
    requestPermission as sdkRequestPermission,
    requestResourceAllocation as sdkRequestResourceAllocation,
    subscribeConnectionStatus,
} from "@parity/product-sdk-host";
import type { ContactHandle, ContactPickOutcome, HostInfo, HostPlatform } from "@parity/truapi";
import { type ReadonlyStore, type Store, createLazyStore, createStore } from "./store.js";

export type HostMode = "unknown" | "host" | "standalone";

export type {
    ContactHandle,
    ContactPickOutcome,
    HostChainDiscovery,
    HostChainIdentifier,
    HostConnectionStatus,
    HostInfo,
    HostPlatform,
};

/** Canonical product identifier the host derives accounts and permissions from. */
export interface ProductContext {
    /** Full dotNS identifier including its network TLD (`my-app.dot`, `my-app.paseo`, `localhost:3000`). */
    productId: string;
}

/** Collapse the SDK's Result union into the throw-on-error idiom hooks expose. */
export function unwrapResult<T, E extends Error = HostError>(result: Result<T, E>): T {
    if (!result.ok) throw result.error;
    return result.value;
}

export interface HostController {
    mode: ReadonlyStore<HostMode>;
    /**
     * Host-channel transport status: `"connecting"` while the client waits for
     * the host, `"connected"` once the channel is up, `"disconnected"`
     * standalone or after the channel closes.
     */
    connectionStatus: ReadonlyStore<HostConnectionStatus>;
    /** Memoized async host detection; resolves the `mode` store as a side effect. */
    detect(): Promise<boolean>;
    navigate(url: string): Promise<void>;
    requestPermission(permission: RemotePermissionItem): Promise<boolean>;
    requestDevicePermission(kind: DevicePermissionKind): Promise<boolean>;
    requestResourceAllocation(resources: AllocatableResource[]): Promise<AllocationOutcome[]>;
    deriveEntropy(key: Uint8Array): Promise<Uint8Array>;
    featureSupported(feature: Feature): Promise<boolean>;
    isChainSupported(genesisHash: `0x${string}`): Promise<boolean>;
    getChainSpec(genesisHash: `0x${string}`): Promise<ChainSpec | null>;
    /**
     * Host identity and version (`System.host_info`). Null standalone and on
     * hosts that predate the method — treat it as best-effort.
     */
    getInfo(): Promise<HostInfo | null>;
    /**
     * The canonical product id the host bound this runtime to
     * (`System.get_product_context`). Null standalone or on legacy hosts.
     */
    getProductContext(): Promise<ProductContext | null>;
    /**
     * RFC-0026 chain discovery: resolve chain roles to genesis hashes against
     * the host's configured network. Null standalone, on legacy hosts, or when
     * the host serves none of the roles.
     */
    getChainInfo(identifiers: readonly HostChainIdentifier[]): Promise<HostChainDiscovery | null>;
    /**
     * Open the host's contact picker (`Contacts.pick`). The product never sees
     * the contact list: the user picks in host UI and the product receives an
     * opaque handle it can only hand back to the host. Resolves `Dismissed` or
     * `NoContacts` as data; throws `HostUnavailableError` standalone and on
     * hosts that serve no picker.
     */
    pickContact(): Promise<ContactPickOutcome>;
    /** Background-operation bookkeeping for Worker-execution products. */
    worker: HostWorker;
    pushNotification(input: PushNotificationInput): Promise<NotificationId>;
    cancelNotification(id: NotificationId): Promise<void>;
    storage: HostKvStorage;
}

export interface HostWorker {
    /**
     * Begin a pending operation: the host keeps the product's worker alive while
     * at least one is open. Resolves the operation id. Host-only.
     */
    beginOperation(label?: string): Promise<number>;
    /** End a pending operation. Idempotent, so a retry after an ambiguous failure is safe. */
    endOperation(id: number): Promise<void>;
}

export interface HostKvStorage {
    getString(key: string): Promise<string | null>;
    setString(key: string, value: string): Promise<void>;
    getJSON<T>(key: string): Promise<T | null>;
    setJSON<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    /**
     * Live value of `key`: the current value first, then every later write or
     * clear by any of the product's runtimes (`LocalStorage.subscribe`).
     * Standalone it follows the browser's cross-tab `storage` event. On hosts
     * that predate the subscription it degrades to a one-shot read.
     */
    watch(
        key: string,
        onValue: (value: string | null) => void,
        options?: { onError?: (error: unknown) => void },
    ): () => void;
}

/**
 * Whether a truapi call error means "this host does not implement the method".
 * New protocol methods are best-effort on older hosts, so callers map this to
 * `null` instead of surfacing an error.
 */
export function isUnsupportedCall(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { tag?: unknown }).tag === "Unsupported"
    );
}

/**
 * Hosts that predate a method's wire id may never answer it at all (rather
 * than replying `Unsupported`), so best-effort probes are bounded. The answer
 * comes from host config with no chain I/O, so a short deadline is enough.
 */
const PROBE_TIMEOUT_MS = 3_000;

type HostCall<T> = {
    match: <A, B>(onOk: (value: T) => A, onErr: (error: unknown) => B) => Promise<A | B>;
};

/**
 * Run a raw truapi call that the SDK has no wrapper for yet. Resolves `null`
 * standalone, when the host reports the method as unsupported, and when a
 * legacy host never answers within the probe deadline; other host errors
 * throw with the host's reason.
 */
async function bestEffortCall<T>(
    detect: () => Promise<boolean>,
    label: string,
    call: (truapi: TruApi) => HostCall<T>,
): Promise<T | null> {
    if (!(await detect())) return null;
    const truapi = await getTruApi();
    if (!truapi) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = call(truapi).match(
        (value) => value,
        (error) => {
            if (isUnsupportedCall(error)) return null;
            throw new Error(`product-sdk: ${label} failed: ${formatHostError(error)}`, {
                cause: error,
            });
        },
    );
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
    });
    return Promise.race([probe, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run a raw truapi call that needs a host: throws `HostUnavailableError`
 * standalone and when the host does not implement the method, and the host's
 * reason for any other failure. No deadline — these calls may wait on the user.
 */
async function hostCall<T>(
    detect: () => Promise<boolean>,
    what: string,
    call: (truapi: TruApi) => HostCall<T>,
): Promise<T> {
    const truapi = (await detect()) ? await getTruApi() : null;
    if (!truapi) throw new HostUnavailableError(what);
    return call(truapi).match(
        (value) => value,
        (error) => {
            if (isUnsupportedCall(error)) {
                throw new HostUnavailableError(`${what}: this host does not implement it`);
            }
            throw new Error(`product-sdk: ${what} failed: ${formatHostError(error)}`, {
                cause: error,
            });
        },
    );
}

const textDecoder = new TextDecoder();

export function createHostController(): HostController {
    const inside = isInsideContainerSync();
    const mode: Store<HostMode> = createStore<HostMode>(inside ? "host" : "unknown");
    let detection: Promise<boolean> | null = null;

    const detect = (): Promise<boolean> => {
        if (!detection) {
            detection = isInsideContainer().then(
                (inside) => {
                    mode.set(inside ? "host" : "standalone");
                    return inside;
                },
                () => {
                    mode.set("standalone");
                    return false;
                },
            );
        }
        return detection;
    };
    detect();

    // Subscribing to the transport status is what builds the client outside an
    // established channel, so only attach once detection says we are hosted.
    const connectionStatus = createLazyStore<HostConnectionStatus>(
        inside ? "connecting" : "disconnected",
        (set) => {
            let cancelled = false;
            let stop: (() => void) | undefined;
            void detect().then((hosted) => {
                if (cancelled) return;
                if (!hosted) {
                    set("disconnected");
                    return;
                }
                stop = subscribeConnectionStatus(set);
            });
            return () => {
                cancelled = true;
                stop?.();
            };
        },
    );

    const requireHost = async <T>(get: () => Promise<T | null>, what: string): Promise<T> => {
        const value = (await detect()) ? await get() : null;
        if (value === null) throw new HostUnavailableError(what);
        return value;
    };

    // Host storage inside a container, browser localStorage standalone — hooks
    // behave identically in both environments.
    const storage: HostKvStorage = {
        async getString(key) {
            if (await detect()) {
                const host = await getHostLocalStorage();
                if (host) {
                    const value = await host.readString(key);
                    // The SDK reads a missing key as "" — normalize to the null every
                    // other store in this module uses.
                    return value === "" ? null : value;
                }
            }
            return globalThis.localStorage?.getItem(key) ?? null;
        },
        async setString(key, value) {
            if (await detect()) {
                const host = await getHostLocalStorage();
                if (host) return host.writeString(key, value);
            }
            globalThis.localStorage?.setItem(key, value);
        },
        async getJSON<T>(key: string): Promise<T | null> {
            const raw = await storage.getString(key);
            return raw === null ? null : (JSON.parse(raw) as T);
        },
        async setJSON<T>(key: string, value: T) {
            await storage.setString(key, JSON.stringify(value));
        },
        async remove(key) {
            if (await detect()) {
                const host = await getHostLocalStorage();
                if (host) return host.clear(key);
            }
            globalThis.localStorage?.removeItem(key);
        },
        watch(key, onValue, options) {
            let cancelled = false;
            let teardown: (() => void) | undefined;
            void detect().then(async (hosted) => {
                if (cancelled) return;
                const truapi = hosted ? await getTruApi() : null;
                if (cancelled) return;
                if (!truapi) {
                    // Standalone: the browser's own store, kept live across tabs.
                    onValue(globalThis.localStorage?.getItem(key) ?? null);
                    const onStorage = (event: StorageEvent) => {
                        if (event.key === null || event.key === key) {
                            onValue(globalThis.localStorage?.getItem(key) ?? null);
                        }
                    };
                    globalThis.addEventListener?.("storage", onStorage);
                    teardown = () => globalThis.removeEventListener?.("storage", onStorage);
                    return;
                }
                // The host emits the current value first, so a settled stream is the
                // live path; a stream that ends before its first item is a host that
                // predates the subscription — degrade to a one-shot read.
                let settled = false;
                const fallback = () => {
                    if (settled) return;
                    settled = true;
                    storage.getString(key).then(onValue, (e) => options?.onError?.(e));
                };
                const sub = truapi.localStorage.subscribe({ request: { key } }).subscribe({
                    next: (item) => {
                        settled = true;
                        const bytes = item.value !== undefined ? fromHex(item.value) : undefined;
                        const text = bytes && bytes.length > 0 ? textDecoder.decode(bytes) : null;
                        onValue(text);
                    },
                    error: (reason) => (settled ? options?.onError?.(reason) : fallback()),
                    complete: () =>
                        settled ? options?.onError?.(new Error("subscription ended")) : fallback(),
                });
                teardown = () => sub.unsubscribe();
                if (cancelled) teardown();
            });
            return () => {
                cancelled = true;
                teardown?.();
            };
        },
    };

    let info: Promise<HostInfo | null> | null = null;
    let productContext: Promise<ProductContext | null> | null = null;

    return {
        mode,
        connectionStatus,
        detect,
        navigate: async (url) => unwrapResult(await sdkNavigateTo(url)),
        requestPermission: async (permission) =>
            unwrapResult(await sdkRequestPermission(permission)),
        requestDevicePermission: async (kind) =>
            unwrapResult(await sdkRequestDevicePermission(kind)),
        requestResourceAllocation: async (resources) =>
            unwrapResult(await sdkRequestResourceAllocation(resources)),
        deriveEntropy: async (key) => unwrapResult(await sdkDeriveEntropy(key)),
        featureSupported: async (feature) => unwrapResult(await sdkFeatureSupported(feature)),
        isChainSupported: async (genesisHash) =>
            unwrapResult(await sdkIsChainSupported(genesisHash)),
        getChainSpec: async (genesisHash) => unwrapResult(await sdkGetChainSpec(genesisHash)),
        // Host identity and product context never change for the life of the
        // connection, so the first answer is cached; failures evict it.
        getInfo: () => {
            if (!info) {
                info = bestEffortCall<HostInfo>(detect, "host info", (truapi) =>
                    truapi.system.info(),
                );
                info.catch(() => {
                    info = null;
                });
            }
            return info;
        },
        getProductContext: () => {
            if (!productContext) {
                productContext = bestEffortCall<ProductContext>(
                    detect,
                    "product context",
                    (truapi) => truapi.system.getProductContext(),
                );
                productContext.catch(() => {
                    productContext = null;
                });
            }
            return productContext;
        },
        getChainInfo: async (identifiers) =>
            (await detect()) ? getHostChainInfo(identifiers) : null,
        pickContact: async () =>
            (
                await hostCall<{ outcome: ContactPickOutcome }>(
                    detect,
                    "contact picker",
                    (truapi) => truapi.contacts.pick({}),
                )
            ).outcome,
        worker: {
            beginOperation: async (label) =>
                (
                    await hostCall<{ id: number }>(detect, "worker operations", (truapi) =>
                        truapi.worker.beginOperation(label !== undefined ? { label } : {}),
                    )
                ).id,
            endOperation: async (id) => {
                await hostCall<undefined>(detect, "worker operations", (truapi) =>
                    truapi.worker.endOperation({ id }),
                );
            },
        },
        pushNotification: async (input) =>
            (await requireHost(getNotificationManager, "notifications")).push(input),
        cancelNotification: async (id) =>
            (await requireHost(getNotificationManager, "notifications")).cancel(id),
        storage,
    };
}
