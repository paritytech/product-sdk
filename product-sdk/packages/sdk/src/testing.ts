// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test fakes for `@parity/product-sdk` (umbrella).
 *
 * `createFakeApp` returns a fake {@link App} — use it directly in logic tests or
 * hand it to `ProductSDKContext.Provider` for React component tests, so code that
 * calls `useProductSDK()` / `useWallet()` runs with no host. This entry also
 * re-exports every package's fakes, for a single meta-package import.
 *
 * @packageDocumentation
 */
import { ProductCloudStorageError } from "@parity/product-sdk-cloud-storage";
import { createFakeHostLocalStorage } from "@parity/product-sdk-local-storage/testing";
import { err, ok, unwrapErr, unwrapOk } from "@parity/result";

import type {
    Account,
    App,
    ChainApi,
    CloudStorageApi,
    LocalStorageApi,
    WalletApi,
} from "./core/types.js";

const textEncoder = new TextEncoder();

// Re-export the per-package fakes so `@parity/product-sdk/testing` is a one-stop import.
// statement-store is deliberately absent: the umbrella doesn't wrap that package, so apps
// using it depend on it directly — import `@parity/product-sdk-statement-store/testing`
// there instead. Re-exporting its fake here would add a dependency the umbrella otherwise
// doesn't have and could skew against the version the app actually installs.
export * from "@parity/product-sdk-local-storage/testing";
export * from "@parity/product-sdk-signer/testing";
export * from "@parity/product-sdk-contracts/testing";
export * from "@parity/product-sdk-host/testing";

/** Configurable behavior for the fake {@link WalletApi}. */
export interface FakeWalletOptions {
    /** Accounts `connect()` / `getAccounts()` expose. Default: none. */
    accounts?: Account[];
    /** Initially selected account. Default: the first account, or `null`. */
    selected?: Account | null;
    /** Bytes returned by `signMessage` / `createProof`. Default: 64 zero bytes. */
    signature?: Uint8Array;
    /** Value returned by `getProductAccount()`. Default: the selected account. */
    productAccount?: Account | null;
    /** Value returned by `getAnonymousAlias()`. Default: `null`. */
    anonymousAlias?: string | null;
}

/** Options for {@link createFakeApp}. */
export interface CreateFakeAppOptions {
    /** App name reported by `getAppInfo()`. Default: `"fake-app"`. */
    name?: string;
    /** Configure the fake wallet. */
    wallet?: FakeWalletOptions;
    /** Override the local-storage API. Default: in-memory (backed by `createFakeHostLocalStorage`). */
    localStorage?: LocalStorageApi;
    /** Override the chain API. Default: unconfigured (throws until you provide one). */
    chain?: ChainApi;
    /** Override cloud storage, or pass `null` to disable it. Default: an in-memory fake. */
    cloudStorage?: CloudStorageApi | null;
}

function makeFakeWallet(options?: FakeWalletOptions): WalletApi {
    const accounts = options?.accounts ?? [];
    let selected = options?.selected !== undefined ? options.selected : (accounts[0] ?? null);
    const signature = options?.signature ?? new Uint8Array(64);
    const listeners = new Set<(account: Account | null) => void>();
    const notify = () => {
        for (const l of listeners) l(selected);
    };

    return {
        async connect() {
            return { accounts };
        },
        async disconnect() {
            selected = null;
            notify();
        },
        getAccounts() {
            return accounts;
        },
        getSelectedAccount() {
            return selected;
        },
        selectAccount(address) {
            selected = accounts.find((a) => a.address === address) ?? null;
            notify();
        },
        async signMessage() {
            return signature;
        },
        async signMessageWithDotNsIdentity(args) {
            return {
                username: args.username ?? "alice",
                accountId: `0x${"00".repeat(32)}`,
                signature,
            };
        },
        onAccountChange(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            };
        },
        getProductAccount() {
            return options?.productAccount !== undefined ? options.productAccount : selected;
        },
        getAnonymousAlias() {
            return options?.anonymousAlias ?? null;
        },
        async createProof() {
            return signature;
        },
    };
}

function makeFakeLocalStorage(): LocalStorageApi {
    // Compose the local-storage fake; mirror createApp's adapter semantics
    // (get normalizes "" -> null, getJSON normalizes undefined -> null).
    const host = createFakeHostLocalStorage();
    return {
        async get(key) {
            return (await host.readString(key)) || null;
        },
        async set(key, value) {
            await host.writeString(key, value);
        },
        async getJSON<T>(key: string) {
            return ((await host.readJSON(key)) ?? null) as T | null;
        },
        async setJSON<T>(key: string, value: T) {
            await host.writeJSON(key, value);
        },
        async remove(key) {
            await host.clear(key);
        },
        async clear() {
            // Unlike the production adapter (a no-op in container mode), the fake
            // actually empties, so tests get real isolation.
            host.reset();
        },
    };
}

function makeFakeCloudStorage(): CloudStorageApi {
    const store = new Map<string, Uint8Array>();
    const toBytes = (data: string | Uint8Array) =>
        typeof data === "string" ? textEncoder.encode(data) : data;
    // Deterministic content-addressed id so upload / computeCid / fetch line up.
    const cidOf = (bytes: Uint8Array) => {
        let h = 0x811c9dc5;
        for (const b of bytes) {
            h ^= b;
            h = Math.imul(h, 0x01000193);
        }
        return `bafyfake${(h >>> 0).toString(16).padStart(8, "0")}`;
    };
    return {
        async upload(data) {
            const bytes = toBytes(data);
            const cid = cidOf(bytes);
            store.set(cid, bytes);
            return ok(cid);
        },
        async fetch(cid) {
            const bytes = store.get(cid);
            if (!bytes) {
                return err(
                    new ProductCloudStorageError(
                        `fake cloud storage: no object stored for CID ${cid}`,
                    ),
                );
            }
            return ok(bytes);
        },
        async computeCid(data) {
            return cidOf(toBytes(data));
        },
    };
}

function makeUnconfiguredChain(): ChainApi {
    const fail = (): never => {
        throw new Error(
            "createFakeApp: `chain` is not configured. Pass a `chain` override in options. " +
                "There is no chain-read fake — the host owns RPC selection; test chain-reading " +
                "logic behind your own interface and cover the real wiring in e2e.",
        );
    };
    // Reads throw (fail fast, no silent undefined); state queries stay quiet.
    return {
        getClient: fail,
        getRawClient: fail,
        connect: fail,
        isConnected: () => false,
        destroyAll: () => {},
    };
}

/**
 * Create a fake {@link App}. Wallet, local-storage, and cloud-storage are working
 * in-memory fakes; `chain` is unconfigured until you override it. Every sub-API
 * is overridable.
 *
 * @example
 * ```ts
 * import { createFakeApp } from "@parity/product-sdk/testing";
 *
 * const app = createFakeApp({ wallet: { accounts: [alice, bob], selected: alice } });
 * await app.wallet.connect();
 * expect(app.wallet.getAccounts()).toHaveLength(2);
 * ```
 *
 * For React, feed the fake to the exported context:
 * ```tsx
 * import { ProductSDKContext } from "@parity/product-sdk/react";
 * render(<ProductSDKContext.Provider value={app}><AccountPicker /></ProductSDKContext.Provider>);
 * ```
 */
export function createFakeApp(options?: CreateFakeAppOptions): App {
    const name = options?.name ?? "fake-app";
    return {
        wallet: makeFakeWallet(options?.wallet),
        localStorage: options?.localStorage ?? makeFakeLocalStorage(),
        chain: options?.chain ?? makeUnconfiguredChain(),
        cloudStorage:
            options?.cloudStorage !== undefined ? options.cloudStorage : makeFakeCloudStorage(),
        getAppInfo: () => ({ name }),
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    const alice: Account = { address: "5Alice", name: "Alice", source: "dev" };
    const bob: Account = { address: "5Bob", name: "Bob", source: "dev" };

    describe("createFakeApp", () => {
        test("wallet lists, selects, and notifies on account change", async () => {
            const app = createFakeApp({ wallet: { accounts: [alice, bob], selected: alice } });
            expect(app.wallet.getAccounts()).toHaveLength(2);
            expect(app.wallet.getSelectedAccount()).toEqual(alice);

            let changed: Account | null = null;
            app.wallet.onAccountChange((a) => {
                changed = a;
            });
            app.wallet.selectAccount("5Bob");
            expect(app.wallet.getSelectedAccount()).toEqual(bob);
            expect(changed).toEqual(bob);

            const { accounts } = await app.wallet.connect();
            expect(accounts).toHaveLength(2);
        });

        test("localStorage round-trips and clear empties it", async () => {
            const app = createFakeApp();
            await app.localStorage.set("k", "v");
            await app.localStorage.setJSON("o", { n: 1 });
            expect(await app.localStorage.get("k")).toBe("v");
            expect(await app.localStorage.getJSON("o")).toEqual({ n: 1 });
            expect(await app.localStorage.get("missing")).toBeNull();

            await app.localStorage.clear();
            expect(await app.localStorage.get("k")).toBeNull();
        });

        test("cloudStorage round-trips upload -> fetch; computeCid matches upload", async () => {
            const cs = createFakeApp().cloudStorage;
            if (!cs) throw new Error("expected default cloud storage");
            const cid = unwrapOk(await cs.upload("hello"));
            expect(await cs.computeCid("hello")).toBe(cid);
            expect(new TextDecoder().decode(unwrapOk(await cs.fetch(cid)))).toBe("hello");
            expect(unwrapErr(await cs.fetch("bafyfakemissing"))).toBeInstanceOf(
                ProductCloudStorageError,
            );
        });

        test("cloudStorage can be disabled with null", () => {
            expect(createFakeApp({ cloudStorage: null }).cloudStorage).toBeNull();
        });

        test("chain is unconfigured by default", () => {
            const app = createFakeApp();
            expect(app.chain.isConnected({} as never)).toBe(false);
            expect(() => app.chain.getClient({} as never)).toThrow(/not configured/);
        });

        test("getAppInfo reports the name", () => {
            expect(createFakeApp({ name: "my-app" }).getAppInfo().name).toBe("my-app");
        });
    });
}
