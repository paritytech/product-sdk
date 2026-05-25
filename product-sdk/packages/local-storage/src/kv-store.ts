import { getHostLocalStorage } from "@parity/product-sdk-host";
import type { HostLocalStorage } from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";

import type { LocalKvStore, LocalKvStoreOptions } from "./types.js";

const log = createLogger("storage");

function prefixer(prefix?: string): (key: string) => string {
    return prefix ? (key) => `${prefix}:${key}` : (key) => key;
}

function createHostBackend(
    hostLocalStorage: HostLocalStorage,
    applyPrefix: (key: string) => string,
): LocalKvStore {
    return {
        async get(key) {
            try {
                const value = await hostLocalStorage.readString(applyPrefix(key));
                // product-sdk decodes missing keys as "" — normalize to null
                return value || null;
            } catch (e) {
                log.warn("Host readString failed", { key, error: e });
                return null;
            }
        },

        async set(key, value) {
            try {
                await hostLocalStorage.writeString(applyPrefix(key), value);
            } catch (e) {
                log.warn("Host writeString failed", { key, error: e });
            }
        },

        async remove(key) {
            try {
                await hostLocalStorage.clear(applyPrefix(key));
            } catch (e) {
                log.warn("Host clear failed", { key, error: e });
            }
        },

        async getJSON<T>(key: string): Promise<T | null> {
            try {
                const value = await hostLocalStorage.readJSON(applyPrefix(key));
                return (value ?? null) as T | null;
            } catch (e) {
                log.warn("Host readJSON failed", { key, error: e });
                return null;
            }
        },

        async setJSON(key, value) {
            try {
                await hostLocalStorage.writeJSON(applyPrefix(key), value);
            } catch (e) {
                log.warn("Host writeJSON failed", { key, error: e });
            }
        },
    };
}

/**
 * Create a key-value store.
 *
 * Uses the host localStorage when inside a container. The SDK is designed
 * to run exclusively inside a host container.
 *
 * @throws {Error} If host storage is unavailable (not inside a container).
 */
export async function createLocalKvStore(options?: LocalKvStoreOptions): Promise<LocalKvStore> {
    const applyPrefix = prefixer(options?.prefix);

    // Explicit host storage takes precedence
    if (options?.hostLocalStorage) {
        return createHostBackend(options.hostLocalStorage, applyPrefix);
    }

    // Auto-detect host storage
    const hostStorage = await getHostLocalStorage();
    if (!hostStorage) {
        throw new Error(
            "Host storage unavailable. Ensure you are running inside a host container (Polkadot Browser / Desktop).",
        );
    }

    return createHostBackend(hostStorage, applyPrefix);
}

if (import.meta.vitest) {
    const { test, expect, describe, beforeEach, vi } = import.meta.vitest;
    const { configure } = await import("@parity/product-sdk-logger");

    // Silence logger during tests
    beforeEach(() => configure({ handler: () => {} }));

    function mockHostStorage(): HostLocalStorage & { data: Map<string, unknown> } {
        const data = new Map<string, unknown>();
        return {
            data,
            async readString(key) {
                return (data.get(key) as string) ?? "";
            },
            async writeString(key, value) {
                data.set(key, value);
                return undefined;
            },
            async readJSON(key) {
                return data.get(key) ?? null;
            },
            async writeJSON(key, value) {
                data.set(key, value);
                return undefined;
            },
            async readBytes(key) {
                return (data.get(key) as Uint8Array | undefined) ?? undefined;
            },
            async writeBytes(key, value) {
                data.set(key, value);
                return undefined;
            },
            async clear(key) {
                data.delete(key);
                return undefined;
            },
        };
    }

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

    describe("createLocalKvStore", () => {
        test("uses explicit hostLocalStorage when provided", async () => {
            const host = mockHostStorage();
            const kv = await createLocalKvStore({ hostLocalStorage: host, prefix: "test" });
            await kv.set("k", "v");
            expect(host.data.get("test:k")).toBe("v");
        });

        test("throws when host storage unavailable", async () => {
            const hostMod = await import("@parity/product-sdk-host");
            vi.spyOn(hostMod, "getHostLocalStorage").mockResolvedValue(null);
            try {
                await expect(createLocalKvStore({ prefix: "app" })).rejects.toThrow(
                    /Host storage unavailable/,
                );
            } finally {
                vi.restoreAllMocks();
            }
        });

        test("auto-detects host storage when available", async () => {
            const host = mockHostStorage();
            const hostMod = await import("@parity/product-sdk-host");
            vi.spyOn(hostMod, "getHostLocalStorage").mockResolvedValue(host);
            try {
                const kv = await createLocalKvStore({ prefix: "auto" });
                await kv.set("k", "v");
                expect(host.data.get("auto:k")).toBe("v");
            } finally {
                vi.restoreAllMocks();
            }
        });
    });
}
