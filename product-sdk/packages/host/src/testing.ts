// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test fakes for `@parity/product-sdk-host`.
 *
 * The host reaches its container through one cached `TrUApiClient`.
 * `createFakeHost()` injects a fake via `setTruApiClient` so every accessor
 * (`getHostLocalStorage`, `getAccountsProvider`, `getStatementStore`, `getTruApi`,
 * …) resolves against it and `isInsideContainer()` reports `true` — which also
 * makes a default `SignerManager`, `local-storage` auto-detection, and the
 * `statement-store` / `cloud-storage` host paths testable.
 *
 * Not modeled: the PAPI `chain` JSON-RPC surface behind `getHostProvider()`.
 * There's no chain-read fake, by design — the host owns RPC selection.
 *
 * @packageDocumentation
 */
import type { ObservableLike, TrUApiClient } from "@parity/truapi";
import { okAsync } from "neverthrow";

import { setTruApiClient } from "./transport.js";

export { setTruApiClient };

/** Inlined to keep the `truapi` facade out of this entry's bundle. */
function toHex(bytes: Uint8Array): `0x${string}` {
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** An `ObservableLike` that never emits. Drive statement delivery with `createFakeStatementTransport`. */
function inertObservable(): ObservableLike<never> {
    return {
        subscribe: () => ({ unsubscribe: () => {} }),
    } as unknown as ObservableLike<never>;
}

/**
 * An `ObservableLike` that emits `item` once, asynchronously. The microtask defer
 * matters: the caller assigns its subscription handle from the return value, so
 * the item must arrive after `subscribe()` returns, not during it.
 */
function oneShotObservable<T>(item: T): ObservableLike<T> {
    return {
        subscribe: (observer: { next?: (value: T) => void }) => {
            queueMicrotask(() => observer.next?.(item));
            return { unsubscribe: () => {} };
        },
    } as unknown as ObservableLike<T>;
}

/** Deterministic `0x`-prefixed preimage key derived from a hex value (FNV-1a). */
function preimageKey(hexValue: string): `0x${string}` {
    let h = 0x811c9dc5;
    for (let i = 0; i < hexValue.length; i++) {
        h ^= hexValue.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return `0x${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Options for {@link createFakeTruApiClient}. */
export interface CreateFakeTruApiClientOptions {
    /** `account.getUserId` primary username. Default `"alice.dot"`. */
    primaryUsername?: string;
    /** Product-account public key. Default 32 bytes of `0x11`. */
    publicKey?: Uint8Array;
    /** Bytes returned by the signing domain (signatures / proofs / transactions). Default 64 bytes of `0x22`. */
    signature?: Uint8Array;
    /** Whether `system.featureSupported` reports the chain supported. Default `true`. */
    chainSupported?: boolean;
    /** Seed the in-memory host localStorage, keyed by storage key. */
    localStorage?: Record<string, Uint8Array>;
    /** Legacy accounts returned by `account.getLegacyAccounts`. Default none. */
    legacyAccounts?: Array<{ publicKey: Uint8Array; name: string }>;
    /** Seed the in-memory preimage store, keyed by the `0x` preimage key. */
    preimages?: Record<string, Uint8Array>;
}

/**
 * Build a fake `TrUApiClient` covering the domains the host accessors use:
 * `localStorage` (real in-memory KV), `account` / `signing` (canned data),
 * `statementStore`, `preimage`, and `system.featureSupported`. `chain` is a stub.
 */
export function createFakeTruApiClient(options?: CreateFakeTruApiClientOptions): TrUApiClient {
    const primaryUsername = options?.primaryUsername ?? "alice.dot";
    const publicKey = toHex(options?.publicKey ?? new Uint8Array(32).fill(0x11));
    const signature = toHex(options?.signature ?? new Uint8Array(64).fill(0x22));
    const chainSupported = options?.chainSupported ?? true;

    // Real in-memory KV (hex values) so getHostLocalStorage()/createLocalKvStore() round-trip.
    const kv = new Map<string, `0x${string}`>();
    for (const [key, value] of Object.entries(options?.localStorage ?? {})) {
        kv.set(key, toHex(value));
    }

    const legacyAccounts = (options?.legacyAccounts ?? []).map((a) => ({
        publicKey: toHex(a.publicKey),
        name: a.name,
    }));

    // Preimage store (hex key -> hex value), for getPreimageManager() and submit/lookup round-trips.
    const preimages = new Map<string, `0x${string}`>();
    for (const [key, value] of Object.entries(options?.preimages ?? {})) {
        preimages.set(key, toHex(value));
    }

    const client = {
        localStorage: {
            read: ({ key }: { key: string }) => okAsync({ value: kv.get(key) }),
            write: ({ key, value }: { key: string; value: `0x${string}` }) => {
                kv.set(key, value);
                return okAsync(undefined);
            },
            clear: ({ key }: { key: string }) => {
                kv.delete(key);
                return okAsync(undefined);
            },
        },
        account: {
            getUserId: () => okAsync({ primaryUsername }),
            requestLogin: () => okAsync({ primaryUsername }),
            getAccount: () => okAsync({ account: { publicKey } }),
            getAccountAlias: () =>
                okAsync({ context: toHex(new Uint8Array([1])), alias: toHex(new Uint8Array([2])) }),
            getLegacyAccounts: () => okAsync({ accounts: legacyAccounts }),
            createAccountProof: () => okAsync({ proof: signature }),
            connectionStatusSubscribe: () => inertObservable(),
        },
        signing: {
            createTransaction: () => okAsync({ transaction: signature }),
            createTransactionWithLegacyAccount: () => okAsync({ transaction: signature }),
            signRaw: () => okAsync({ signature }),
            signRawWithLegacyAccount: () => okAsync({ signature }),
        },
        statementStore: {
            subscribe: () => inertObservable(),
            createProofAuthorized: () =>
                okAsync({ proof: { tag: "Sr25519", value: { signature, signer: publicKey } } }),
            submit: () => okAsync(undefined),
        },
        system: {
            featureSupported: () => okAsync({ supported: chainSupported }),
        },
        preimage: {
            lookupSubscribe: ({ request: { key } }: { request: { key: string } }) =>
                oneShotObservable({ value: preimages.get(key) }),
            submit: (value: `0x${string}`) => {
                const key = preimageKey(value);
                preimages.set(key, value);
                return okAsync(key);
            },
        },
        // chain.* is read lazily by the PAPI provider; the full JSON-RPC surface
        // is out of scope (see module header), so this stays a stub.
        chain: {},
    };

    return client as unknown as TrUApiClient;
}

/**
 * A `beforeEach`-registered test hook, e.g. Vitest's `onTestFinished`. Read off
 * `globalThis` so we couple to no test framework: present under Vitest's globals
 * mode, absent everywhere else (Jest, `node:test`, plain scripts).
 */
type TestFinishedHook = (fn: () => void) => void;

/** Handle returned by {@link createFakeHost}. */
export interface FakeHost extends Disposable {
    /** The injected fake client (also what `getTruApi()` returns). */
    client: TrUApiClient;
    /** Clear the override. Idempotent; safe to call more than once. */
    dispose(): void;
    /** `using host = createFakeHost()` restores the real client at scope end. */
    [Symbol.dispose](): void;
}

/**
 * Inject a fake client via {@link setTruApiClient} and return a disposer.
 *
 * Cleanup is guaranteed three ways, so a forgotten reset can't leak the override
 * into the next test or file: prefer `using` (scope-end disposal), otherwise the
 * handle self-registers `onTestFinished` when created inside a Vitest run, and
 * `dispose()` is always there to call by hand.
 *
 * @example
 * ```ts
 * import { createFakeHost } from "@parity/product-sdk-host/testing";
 *
 * test("host storage is reachable", async () => {
 *   using host = createFakeHost({ primaryUsername: "carol.dot" });
 *   // getHostLocalStorage(), getAccountsProvider(), a default SignerManager, etc.
 *   // resolve the fake; the real client is restored when the test scope ends.
 * });
 * ```
 */
export function createFakeHost(options?: CreateFakeTruApiClientOptions): FakeHost {
    const client = createFakeTruApiClient(options);
    setTruApiClient(client);

    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        setTruApiClient(null);
    };

    // Best-effort auto-cleanup for the common case (a bare `const host =
    // createFakeHost()` with no `using` and no manual reset). Under Vitest's
    // globals mode `onTestFinished` is on `globalThis`; elsewhere it's absent and
    // we quietly rely on `using` / manual `dispose()`.
    const onTestFinished = (globalThis as { onTestFinished?: TestFinishedHook }).onTestFinished;
    if (typeof onTestFinished === "function") {
        try {
            onTestFinished(dispose);
        } catch {
            // Not inside a running test (e.g. called at module scope) — ignore.
        }
    }

    return {
        client,
        dispose,
        [Symbol.dispose]: dispose,
    };
}

if (import.meta.vitest) {
    // Round-trip guard: drive the fake through the *real* host accessors.
    const { describe, test, expect, afterEach } = import.meta.vitest;
    const { getHostLocalStorage, getStatementStore, isInsideContainer } = await import(
        "./container.js"
    );
    const { getAccountsProvider } = await import("./accounts.js");
    const { getPreimageManager } = await import("./truapi.js");

    const lookupOnce = (
        manager: NonNullable<Awaited<ReturnType<typeof getPreimageManager>>>,
        key: `0x${string}`,
    ) =>
        new Promise<Uint8Array | null>((resolve) => {
            manager.lookup(key, (preimage) => {
                if (preimage !== null) resolve(preimage);
            });
        });

    afterEach(() => setTruApiClient(null));

    describe("createFakeHost / createFakeTruApiClient", () => {
        test("host localStorage round-trips through the real adapter", async () => {
            createFakeHost();
            const ls = await getHostLocalStorage();
            expect(ls).not.toBeNull();
            await ls?.writeString("k", "v");
            expect(await ls?.readString("k")).toBe("v");
            await ls?.writeJSON("j", { a: 1 });
            expect(await ls?.readJSON("j")).toEqual({ a: 1 });
            expect(await ls?.readString("missing")).toBe("");
        });

        test("seeded localStorage is readable", async () => {
            createFakeHost({ localStorage: { greeting: new TextEncoder().encode("hi") } });
            const ls = await getHostLocalStorage();
            expect(await ls?.readString("greeting")).toBe("hi");
        });

        test("accounts provider resolves the configured user", async () => {
            createFakeHost({ primaryUsername: "carol.dot" });
            const accounts = await getAccountsProvider();
            expect(accounts).not.toBeNull();
            const userId = await accounts?.getUserId().match(
                (v) => v,
                () => null,
            );
            expect(userId?.primaryUsername).toBe("carol.dot");
        });

        test("statement store resolves", async () => {
            createFakeHost();
            expect(await getStatementStore()).not.toBeNull();
        });

        test("preimage manager reads seeded bytes and round-trips submit -> lookup", async () => {
            createFakeHost({ preimages: { "0xabc": new Uint8Array([1, 2, 3]) } });
            const pm = await getPreimageManager();
            expect(pm).not.toBeNull();

            const seeded = await lookupOnce(pm!, "0xabc");
            expect(Array.from(seeded ?? [])).toEqual([1, 2, 3]);

            const key = await pm!.submit(new Uint8Array([9, 9]));
            const back = await lookupOnce(pm!, key);
            expect(Array.from(back ?? [])).toEqual([9, 9]);
        });

        test("isInsideContainer is true while set, false after dispose", async () => {
            const host = createFakeHost();
            expect(await isInsideContainer()).toBe(true);
            host.dispose();
            expect(await isInsideContainer()).toBe(false);
            expect(await getHostLocalStorage()).toBeNull();
        });

        test("Symbol.dispose clears the override and dispose is idempotent", async () => {
            {
                using host = createFakeHost();
                expect(await isInsideContainer()).toBe(true);
                host.dispose(); // explicit + scope-end Symbol.dispose must not double-clear badly
            }
            expect(await isInsideContainer()).toBe(false);
        });
    });
}
