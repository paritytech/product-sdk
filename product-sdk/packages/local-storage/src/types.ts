import type { HostLocalStorage } from "@parity/product-sdk-host";

/** Async string local key-value store, with `getJSON`/`setJSON` for structured values. Returned by {@link createLocalKvStore}. */
export interface LocalKvStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    getJSON<T>(key: string): Promise<T | null>;
    setJSON(key: string, value: unknown): Promise<void>;
}

/** Optional configuration for {@link createLocalKvStore}: a key prefix to namespace entries, or an explicit host-storage handle that overrides auto-detection. */
export interface LocalKvStoreOptions {
    /** Key prefix to namespace storage keys (e.g. "myapp" → keys become "myapp:theme"). */
    prefix?: string;
    /** Override auto-detection. When provided, routes all ops through this host storage. */
    hostLocalStorage?: HostLocalStorage;
}
