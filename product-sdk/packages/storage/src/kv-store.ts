import { isInsideContainer, getHostLocalStorage } from "@parity/product-sdk-host";
import type { HostLocalStorage } from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";

import type { KvStore, KvStoreOptions } from "./types.js";

const log = createLogger("storage");

function prefixer(prefix?: string): (key: string) => string {
    return prefix ? (key) => `${prefix}:${key}` : (key) => key;
}

function createLocalStorageBackend(applyPrefix: (key: string) => string): KvStore {
    const available = typeof globalThis.localStorage !== "undefined";

    if (!available) {
        log.debug("No localStorage available (SSR/Node)");
    }

    return {
        async get(key) {
            if (!available) return null;
            try {
                return globalThis.localStorage.getItem(applyPrefix(key));
            } catch (e) {
                log.warn("localStorage.getItem failed", { key, error: e });
                return null;
            }
        },

        async set(key, value) {
            if (!available) return;
            try {
                globalThis.localStorage.setItem(applyPrefix(key), value);
            } catch (e) {
                log.warn("localStorage.setItem failed", { key, error: e });
            }
        },

        async remove(key) {
            if (!available) return;
            try {
                globalThis.localStorage.removeItem(applyPrefix(key));
            } catch (e) {
                log.warn("localStorage.removeItem failed", { key, error: e });
            }
        },

        async getJSON<T>(key: string): Promise<T | null> {
            const raw = await this.get(key);
            if (raw === null) return null;
            try {
                return JSON.parse(raw) as T;
            } catch (e) {
                log.warn("JSON parse failed for key", { key, error: e });
                return null;
            }
        },

        async setJSON(key, value) {
            await this.set(key, JSON.stringify(value));
        },
    };
}

function createHostBackend(
    hostStorage: HostLocalStorage,
    applyPrefix: (key: string) => string,
): KvStore {
    return {
        async get(key) {
            try {
                const value = await hostStorage.readString(applyPrefix(key));
                // product-sdk decodes missing keys as "" — normalize to null
                return value || null;
            } catch (e) {
                log.warn("Host readString failed", { key, error: e });
                return null;
            }
        },

        async set(key, value) {
            try {
                await hostStorage.writeString(applyPrefix(key), value);
            } catch (e) {
                log.warn("Host writeString failed", { key, error: e });
            }
        },

        async remove(key) {
            try {
                await hostStorage.clear(applyPrefix(key));
            } catch (e) {
                log.warn("Host clear failed", { key, error: e });
            }
        },

        async getJSON<T>(key: string): Promise<T | null> {
            try {
                const value = await hostStorage.readJSON(applyPrefix(key));
                return (value ?? null) as T | null;
            } catch (e) {
                log.warn("Host readJSON failed", { key, error: e });
                return null;
            }
        },

        async setJSON(key, value) {
            try {
                await hostStorage.writeJSON(applyPrefix(key), value);
            } catch (e) {
                log.warn("Host writeJSON failed", { key, error: e });
            }
        },
    };
}

export async function createKvStore(options?: KvStoreOptions): Promise<KvStore> {
    const applyPrefix = prefixer(options?.prefix);

    // Explicit host storage takes precedence
    if (options?.hostLocalStorage) {
        return createHostBackend(options.hostLocalStorage, applyPrefix);
    }

    // Auto-detect container environment
    if (await isInsideContainer()) {
        const hostStorage = await getHostLocalStorage();
        if (hostStorage) {
            return createHostBackend(hostStorage, applyPrefix);
        }
        log.warn(
            "Inside container but failed to obtain host localStorage, falling back to browser",
        );
    }

    return createLocalStorageBackend(applyPrefix);
}

if (import.meta.vitest) {
    const { test, expect, describe, beforeEach, afterEach, vi } = import.meta.vitest;
    const { configure } = await import("@parity/product-sdk-logger");

    // Silence logger during tests
    beforeEach(() => configure({ handler: () => {} }));

    function shimLocalStorage(): {
        store: Record<string, string>;
        cleanup: () => void;
    } {
        const store: Record<string, string> = {};
        // @ts-expect-error — shimming localStorage for test
        globalThis.localStorage = {
            getItem: (k: string) => store[k] ?? null,
            setItem: (k: string, v: string) => {
                store[k] = v;
            },
            removeItem: (k: string) => {
                delete store[k];
            },
        };
        return {
            store,
            cleanup: () => {
                // @ts-expect-error — remove shim
                globalThis.localStorage = undefined;
            },
        };
    }

    function mockHostStorage(): HostLocalStorage & { data: Map<string, unknown> } {
        const data = new Map<string, unknown>();
        return {
            data,
            async readString(key) {
                return (data.get(key) as string) ?? "";
            },
            async writeString(key, value) {
                data.set(key, value);
            },
            async readJSON<T>(key: string): Promise<T | null> {
                return (data.get(key) as T) ?? null;
            },
            async writeJSON(key, value) {
                data.set(key, value);
            },
            async clear() {
                data.clear();
            },
        };
    }

    describe("localStorage backend", () => {
        let cleanup: () => void;
        let store: Record<string, string>;

        beforeEach(() => {
            const shim = shimLocalStorage();
            store = shim.store;
            cleanup = shim.cleanup;
        });
        afterEach(() => cleanup());

        test("get/set round-trip", async () => {
            const kv = createLocalStorageBackend((k) => k);
            await kv.set("key", "value");
            expect(await kv.get("key")).toBe("value");
        });

        test("get returns null for missing key", async () => {
            const kv = createLocalStorageBackend((k) => k);
            expect(await kv.get("missing")).toBeNull();
        });

        test("remove deletes key", async () => {
            const kv = createLocalStorageBackend((k) => k);
            await kv.set("key", "value");
            await kv.remove("key");
            expect(await kv.get("key")).toBeNull();
        });

        test("getJSON/setJSON round-trip", async () => {
            const kv = createLocalStorageBackend((k) => k);
            await kv.setJSON("obj", { a: 1, b: "two" });
            expect(await kv.getJSON("obj")).toEqual({ a: 1, b: "two" });
        });

        test("getJSON returns null on corrupted JSON", async () => {
            const kv = createLocalStorageBackend((k) => k);
            store.bad = "not-json{{{";
            expect(await kv.getJSON("bad")).toBeNull();
        });

        test("getJSON returns null for missing key", async () => {
            const kv = createLocalStorageBackend((k) => k);
            expect(await kv.getJSON("nope")).toBeNull();
        });

        test("get returns null when localStorage throws", async () => {
            globalThis.localStorage.getItem = () => {
                throw new Error("SecurityError");
            };
            const kv = createLocalStorageBackend((k) => k);
            expect(await kv.get("key")).toBeNull();
        });

        test("set silently catches when localStorage throws", async () => {
            globalThis.localStorage.setItem = () => {
                throw new Error("QuotaExceededError");
            };
            const kv = createLocalStorageBackend((k) => k);
            await expect(kv.set("key", "val")).resolves.toBeUndefined();
        });

        test("remove silently catches when localStorage throws", async () => {
            globalThis.localStorage.removeItem = () => {
                throw new Error("SecurityError");
            };
            const kv = createLocalStorageBackend((k) => k);
            await expect(kv.remove("key")).resolves.toBeUndefined();
        });
    });

    describe("prefix", () => {
        let cleanup: () => void;
        let store: Record<string, string>;

        beforeEach(() => {
            const shim = shimLocalStorage();
            store = shim.store;
            cleanup = shim.cleanup;
        });
        afterEach(() => cleanup());

        test("keys are prefixed", async () => {
            const kv = createLocalStorageBackend(prefixer("myapp"));
            await kv.set("theme", "dark");
            expect(store["myapp:theme"]).toBe("dark");
            expect(await kv.get("theme")).toBe("dark");
        });

        test("no prefix means keys used as-is", async () => {
            const kv = createLocalStorageBackend(prefixer());
            await kv.set("theme", "dark");
            expect(store.theme).toBe("dark");
        });
    });

    describe("host backend", () => {
        test("routes through host storage", async () => {
            const host = mockHostStorage();
            const kv = createHostBackend(host, (k) => k);
            await kv.set("key", "val");
            expect(await kv.get("key")).toBe("val");
        });

        test("getJSON/setJSON routes through host", async () => {
            const host = mockHostStorage();
            const kv = createHostBackend(host, (k) => k);
            await kv.setJSON("obj", { x: 42 });
            expect(await kv.getJSON("obj")).toEqual({ x: 42 });
        });

        test("get returns null when host throws", async () => {
            const host = mockHostStorage();
            host.readString = async () => {
                throw new Error("host error");
            };
            const kv = createHostBackend(host, (k) => k);
            expect(await kv.get("key")).toBeNull();
        });

        test("getJSON returns null when host throws", async () => {
            const host = mockHostStorage();
            host.readJSON = async () => {
                throw new Error("host error");
            };
            const kv = createHostBackend(host, (k) => k);
            expect(await kv.getJSON("key")).toBeNull();
        });

        test("prefix applied to host keys", async () => {
            const host = mockHostStorage();
            const kv = createHostBackend(host, prefixer("app"));
            await kv.set("key", "val");
            expect(host.data.get("app:key")).toBe("val");
        });

        test("get returns null for missing key (empty string from host)", async () => {
            const host = mockHostStorage();
            const kv = createHostBackend(host, (k) => k);
            // host.readString returns "" for missing keys, should normalize to null
            expect(await kv.get("missing")).toBeNull();
        });

        test("getJSON returns null for missing key (undefined from host)", async () => {
            const host = mockHostStorage();
            const kv = createHostBackend(host, (k) => k);
            expect(await kv.getJSON("missing")).toBeNull();
        });

        test("set silently catches host write errors", async () => {
            const host = mockHostStorage();
            host.writeString = async () => {
                throw new Error("quota");
            };
            const kv = createHostBackend(host, (k) => k);
            await expect(kv.set("key", "val")).resolves.toBeUndefined();
        });

        test("setJSON silently catches host write errors", async () => {
            const host = mockHostStorage();
            host.writeJSON = async () => {
                throw new Error("quota");
            };
            const kv = createHostBackend(host, (k) => k);
            await expect(kv.setJSON("key", { a: 1 })).resolves.toBeUndefined();
        });

        test("remove silently catches host clear errors", async () => {
            const host = mockHostStorage();
            host.clear = async () => {
                throw new Error("fail");
            };
            const kv = createHostBackend(host, (k) => k);
            await expect(kv.remove("key")).resolves.toBeUndefined();
        });
    });

    describe("SSR (no localStorage)", () => {
        test("get returns null", async () => {
            const kv = createLocalStorageBackend((k) => k);
            expect(await kv.get("anything")).toBeNull();
        });

        test("set is a no-op", async () => {
            const kv = createLocalStorageBackend((k) => k);
            await expect(kv.set("key", "value")).resolves.toBeUndefined();
        });

        test("getJSON returns null", async () => {
            const kv = createLocalStorageBackend((k) => k);
            expect(await kv.getJSON("anything")).toBeNull();
        });
    });

    describe("createKvStore", () => {
        test("uses explicit hostLocalStorage when provided", async () => {
            const host = mockHostStorage();
            const kv = await createKvStore({ hostLocalStorage: host, prefix: "test" });
            await kv.set("k", "v");
            expect(host.data.get("test:k")).toBe("v");
        });

        test("falls back to localStorage outside container", async () => {
            const { store, cleanup } = shimLocalStorage();
            try {
                const kv = await createKvStore({ prefix: "app" });
                await kv.set("x", "1");
                expect(store["app:x"]).toBe("1");
            } finally {
                cleanup();
            }
        });

        test("auto-detects host storage when inside container", async () => {
            const host = mockHostStorage();
            const hostMod = await import("@parity/product-sdk-host");
            vi.spyOn(hostMod, "isInsideContainer").mockResolvedValue(true);
            vi.spyOn(hostMod, "getHostLocalStorage").mockResolvedValue(host);
            try {
                const kv = await createKvStore({ prefix: "auto" });
                await kv.set("k", "v");
                expect(host.data.get("auto:k")).toBe("v");
            } finally {
                vi.restoreAllMocks();
            }
        });

        test("falls back to localStorage when inside container but host storage unavailable", async () => {
            const { store, cleanup } = shimLocalStorage();
            const hostMod = await import("@parity/product-sdk-host");
            vi.spyOn(hostMod, "isInsideContainer").mockResolvedValue(true);
            vi.spyOn(hostMod, "getHostLocalStorage").mockResolvedValue(null);
            try {
                const kv = await createKvStore({ prefix: "fb" });
                await kv.set("x", "1");
                expect(store["fb:x"]).toBe("1");
            } finally {
                vi.restoreAllMocks();
                cleanup();
            }
        });
    });
}
