import { generateMnemonic } from "@polkadot-labs/hdkd-helpers";
import type { LocalKvStore } from "@parity/product-sdk-local-storage";

import { seedToAccount } from "./seed-to-account.js";
import type { SessionKeyInfo } from "./types.js";

/**
 * Manages an sr25519 account derived from a BIP39 mnemonic.
 *
 * @param options.store - LocalKvStore instance (from `@parity/product-sdk-local-storage`).
 *   Create with `createLocalKvStore({ prefix: "session-key" })` for namespaced persistence.
 * @param options.name - Identifies this session key. Defaults to `"default"`.
 *   Use different names to manage multiple independent session keys.
 *
 * @example
 * ```ts
 * const store = await createLocalKvStore({ prefix: "session-key" });
 * const skm = new SessionKeyManager({ store });
 * const key = await skm.getOrCreate();
 * ```
 */
export class SessionKeyManager {
    private readonly name: string;
    private readonly store: LocalKvStore;

    constructor(options: { store: LocalKvStore; name?: string }) {
        this.name = options.name ?? "default";
        this.store = options.store;
    }

    /**
     * Create a new session key from a fresh mnemonic.
     * Persists the mnemonic to the store.
     */
    async create(): Promise<SessionKeyInfo> {
        const mnemonic = generateMnemonic();
        await this.store.set(this.name, mnemonic);
        return { mnemonic, account: seedToAccount(mnemonic) };
    }

    /**
     * Load an existing session key from the store.
     * Returns null if no mnemonic is stored.
     */
    async get(): Promise<SessionKeyInfo | null> {
        const mnemonic = await this.store.get(this.name);
        if (!mnemonic) return null;
        return { mnemonic, account: seedToAccount(mnemonic) };
    }

    /**
     * Load existing or create a new session key.
     */
    async getOrCreate(): Promise<SessionKeyInfo> {
        const existing = await this.get();
        if (existing) return existing;
        return this.create();
    }

    /**
     * Derive a session key from an explicit mnemonic (no storage interaction).
     */
    fromMnemonic(mnemonic: string): SessionKeyInfo {
        return { mnemonic, account: seedToAccount(mnemonic) };
    }

    /**
     * Clear the stored mnemonic from the store.
     */
    async clear(): Promise<void> {
        await this.store.remove(this.name);
    }
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    const TEST_MNEMONIC =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    function mockLocalKvStore(): LocalKvStore & { data: Map<string, string> } {
        const data = new Map<string, string>();
        return {
            data,
            async get(key) {
                return data.get(key) ?? null;
            },
            async set(key, value) {
                data.set(key, value);
            },
            async remove(key) {
                data.delete(key);
            },
            async getJSON() {
                return null;
            },
            async setJSON() {},
        };
    }

    describe("SessionKeyManager", () => {
        test("fromMnemonic produces deterministic results", () => {
            const store = mockLocalKvStore();
            const skm = new SessionKeyManager({ store });
            const a = skm.fromMnemonic(TEST_MNEMONIC);
            const b = skm.fromMnemonic(TEST_MNEMONIC);
            expect(a.mnemonic).toBe(TEST_MNEMONIC);
            expect(a.account.ss58Address).toBe(b.account.ss58Address);
            expect(a.account.h160Address).toBe(b.account.h160Address);
        });

        test("fromMnemonic throws on invalid mnemonic", () => {
            const store = mockLocalKvStore();
            const skm = new SessionKeyManager({ store });
            expect(() => skm.fromMnemonic("invalid words here")).toThrow("Invalid mnemonic phrase");
        });

        test("create and get round-trip", async () => {
            const store = mockLocalKvStore();
            const skm = new SessionKeyManager({ store });
            const info = await skm.create();
            expect(info.mnemonic).toBeTruthy();
            expect(info.account.ss58Address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
            expect(store.data.get("default")).toBe(info.mnemonic);

            const loaded = await skm.get();
            expect(loaded?.mnemonic).toBe(info.mnemonic);
        });

        test("get returns null when no key stored", async () => {
            const store = mockLocalKvStore();
            const skm = new SessionKeyManager({ store });
            expect(await skm.get()).toBeNull();
        });

        test("getOrCreate creates then returns cached", async () => {
            const store = mockLocalKvStore();
            const skm = new SessionKeyManager({ store });
            const created = await skm.getOrCreate();
            expect(store.data.size).toBe(1);

            const loaded = await skm.getOrCreate();
            expect(loaded.mnemonic).toBe(created.mnemonic);
            expect(loaded.account.ss58Address).toBe(created.account.ss58Address);
        });

        test("clear removes mnemonic from store", async () => {
            const store = mockLocalKvStore();
            const skm = new SessionKeyManager({ store });
            await skm.create();
            expect(store.data.size).toBe(1);

            await skm.clear();
            expect(store.data.size).toBe(0);
            expect(await skm.get()).toBeNull();
        });

        test("name separates storage keys", async () => {
            const store = mockLocalKvStore();
            const main = new SessionKeyManager({ name: "main", store });
            const burner = new SessionKeyManager({ name: "burner", store });

            const mainInfo = await main.create();
            const burnerInfo = await burner.create();

            expect(store.data.get("main")).toBe(mainInfo.mnemonic);
            expect(store.data.get("burner")).toBe(burnerInfo.mnemonic);
            expect(mainInfo.account.ss58Address).not.toBe(burnerInfo.account.ss58Address);

            await main.clear();
            expect(store.data.has("main")).toBe(false);
            expect(store.data.get("burner")).toBe(burnerInfo.mnemonic);
        });
    });
}
