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
 * Not modeled: the PAPI `chain` JSON-RPC surface behind `getHostProvider()` —
 * there's no chain-read fake, by design; the host owns RPC selection — and the
 * `chat` / `coinPayment` / `entropy` / `notifications` / `payment` /
 * `permissions` / `resourceAllocation` / `theme` domains. Touching an unmodeled
 * domain throws a descriptive error rather than failing with `undefined is not
 * a function`.
 *
 * @packageDocumentation
 */
import type { ObservableLike, Observer, Subscription, TrUApiClient } from "@parity/truapi";
import { okAsync } from "neverthrow";

import { setTruApiClient } from "./transport.js";

export { setTruApiClient };

/**
 * The public surface of a generated truapi domain client. `keyof` skips private
 * members, so this is the shape a plain object can implement — the classes
 * themselves are unimplementable outside truapi because of their
 * `private transport`.
 */
type PublicSurface<C> = { [K in keyof C]: C[K] };

/**
 * `TrUApiClient` seen through public surfaces only. The fake is checked against
 * this member-by-member, so drift from the generated client — a renamed method,
 * a changed request or response type — fails compilation here instead of
 * surfacing as a runtime mismatch in consumers' tests.
 */
type PublicTruApiClient = { [D in keyof TrUApiClient]: PublicSurface<TrUApiClient[D]> };

/** Inlined to keep the `truapi` facade out of this entry's bundle. */
function toHex(bytes: Uint8Array): `0x${string}` {
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function fakeSubscription(): Subscription {
    return { unsubscribe: () => {}, subscriptionId: "fake-subscription" };
}

/**
 * Wrap a `subscribe` implementation into a full `ObservableLike`. The
 * `Symbol.observable` interop member only lands on the object when the symbol
 * is polyfilled (e.g. by rxjs) — same as the generated client — and nothing in
 * the SDK reads it; it exists to satisfy the interface.
 */
function makeObservable<Item, Reason = never>(
    subscribe: (observer?: Partial<Observer<Item, Reason>>) => Subscription,
): ObservableLike<Item, Reason> {
    const observable: ObservableLike<Item, Reason> = {
        subscribe,
        [Symbol.observable]() {
            return observable;
        },
    };
    return observable;
}

/** An `ObservableLike` that never emits. Drive statement delivery with `createFakeStatementTransport`. */
function inertObservable<Item, Reason = never>(): ObservableLike<Item, Reason> {
    return makeObservable(() => fakeSubscription());
}

/**
 * An `ObservableLike` that emits `item` once, asynchronously. The microtask defer
 * matters: the caller assigns its subscription handle from the return value, so
 * the item must arrive after `subscribe()` returns, not during it.
 */
function oneShotObservable<Item>(item: Item): ObservableLike<Item> {
    return makeObservable((observer) => {
        queueMicrotask(() => observer?.next?.(item));
        return fakeSubscription();
    });
}

/**
 * A domain the fake deliberately doesn't model (see the module header). Any
 * member access throws with a pointer here, instead of the bare TypeError an
 * empty stub would give. The empty-object cast is the one concession a Proxy
 * needs; every modeled domain is checked structurally.
 */
function notModeled<D extends keyof TrUApiClient>(domain: D): PublicSurface<TrUApiClient[D]> {
    return new Proxy({} as PublicSurface<TrUApiClient[D]>, {
        get(_target, member) {
            // Stay quiet for inspection probes (console.log, await-resolution).
            if (typeof member === "symbol" || member === "then") return undefined;
            throw new Error(
                `createFakeTruApiClient: \`${domain}.${member}\` is not modeled by the fake. See the @parity/product-sdk-host/testing module docs for what is covered.`,
            );
        },
    });
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
 * `statementStore`, `preimage`, and `system`. Unmodeled domains (`chain` et al —
 * see the module header) throw on member access.
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

    // Typed against the generated client's public surface: every method below is
    // structurally checked, so a truapi signature change breaks this file's build,
    // not a consumer's test run.
    const client: PublicTruApiClient = {
        localStorage: {
            read: ({ key }) => okAsync({ value: kv.get(key) }),
            write: ({ key, value }) => {
                kv.set(key, value);
                return okAsync(undefined);
            },
            clear: ({ key }) => {
                kv.delete(key);
                return okAsync(undefined);
            },
        },
        account: {
            getUserId: () => okAsync({ primaryUsername }),
            requestLogin: () => okAsync("Success"),
            getAccount: () => okAsync({ account: { publicKey } }),
            getAccountAlias: () =>
                okAsync({ context: toHex(new Uint8Array([1])), alias: toHex(new Uint8Array([2])) }),
            getLegacyAccounts: () => okAsync({ accounts: legacyAccounts }),
            createAccountProof: () =>
                okAsync({
                    proof: signature,
                    contextualAlias: {
                        context: toHex(new Uint8Array([1])),
                        alias: toHex(new Uint8Array([2])),
                    },
                    ringIndex: 0,
                    ringRevision: 0,
                }),
            signVrf: () => okAsync({ preOutput: publicKey, proof: signature }),
            connectionStatusSubscribe: () => inertObservable(),
        },
        signing: {
            createTransaction: () => okAsync({ transaction: signature }),
            createTransactionWithLegacyAccount: () => okAsync({ transaction: signature }),
            signRaw: () => okAsync({ signature }),
            signRawWithLegacyAccount: () => okAsync({ signature }),
            signPayload: () => okAsync({ signature }),
            signPayloadWithLegacyAccount: () => okAsync({ signature }),
        },
        statementStore: {
            subscribe: () => inertObservable(),
            createProof: () =>
                okAsync({ proof: { tag: "Sr25519", value: { signature, signer: publicKey } } }),
            createProofAuthorized: () =>
                okAsync({ proof: { tag: "Sr25519", value: { signature, signer: publicKey } } }),
            submit: () => okAsync(undefined),
        },
        system: {
            handshake: () => okAsync(undefined),
            featureSupported: () => okAsync({ supported: chainSupported }),
            navigateTo: () => okAsync(undefined),
        },
        preimage: {
            lookupSubscribe: ({ request: { key } }) =>
                oneShotObservable({ value: preimages.get(key) }),
            submit: (value) => {
                const key = preimageKey(value);
                preimages.set(key, value);
                return okAsync(key);
            },
        },
        chain: notModeled("chain"),
        chat: notModeled("chat"),
        coinPayment: notModeled("coinPayment"),
        entropy: notModeled("entropy"),
        notifications: notModeled("notifications"),
        payment: notModeled("payment"),
        permissions: notModeled("permissions"),
        resourceAllocation: notModeled("resourceAllocation"),
        theme: notModeled("theme"),
    };

    // A plain downcast, not an `unknown` bridge: each generated class is
    // assignable to its `PublicSurface`, and TS has already verified every fake
    // member against the generated signatures in the annotation above.
    return client as TrUApiClient;
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

        test("signVrf round-trips through the real adapter", async () => {
            // The fake is the only way a product can test a VRF flow: there is no
            // dev-provider implementation and the e2e test host does not expose the
            // call. So the fake's wire shape has to stay decodable by the adapter.
            createFakeHost();
            const accounts = await getAccountsProvider();
            const signature = await accounts
                ?.signVrf({ dotNsIdentifier: "app.dot" }, new Uint8Array([1]), [
                    { label: new Uint8Array([2]), value: new Uint8Array([3]) },
                ])
                .match(
                    (s) => s,
                    () => null,
                );
            expect(signature?.preOutput).toBeInstanceOf(Uint8Array);
            expect(signature?.proof).toBeInstanceOf(Uint8Array);
            expect(signature?.preOutput).toHaveLength(32);
            expect(signature?.proof).toHaveLength(64);
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
