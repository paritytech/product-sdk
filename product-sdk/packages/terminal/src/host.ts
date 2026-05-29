// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Host-runner facet of `@parity/product-sdk-terminal`. A CLI using this
 * package plays the Host role per RFC-10; this module implements the
 * three §Stakeholders Host responsibilities (AP client, cache, signer)
 * over `@novasamatech/host-papp@0.7.7`'s `UserSession`.
 *
 * @module
 */
import type { UserSession } from "@novasamatech/host-papp";
import { createLogger } from "@parity/product-sdk-logger";
import type { ResultAsync } from "neverthrow";
import type { PolkadotSigner } from "polkadot-api";

import type { TerminalAdapter } from "./adapter.js";
import {
    type CachedAllocation,
    loadCache,
    mergeOutcomes,
    pickOnExistingPolicy,
    readCacheEntry,
    saveCache,
    withCacheLock,
} from "./host-cache.js";
import { buildSignerFromEntry, createSlotAccountSigner } from "./host-signer.js";

// `terminal` namespace matches adapter.ts / node-storage.ts.
const log = createLogger("terminal");

// Public re-exports — internal helpers (loadCache, mergeOutcomes, etc.)
// stay private. CachedAllocation must be exported because it's the return
// type of getCachedAllocation.
export type { CachedAllocation };
export { createSlotAccountSigner };

// Types derived from `UserSession['requestResourceAllocation']` so upstream
// codec changes surface as compile errors here, not runtime decode failures.
// host-papp doesn't re-export these codec types from its root.
type ResourceAllocationRequest = Parameters<UserSession["requestResourceAllocation"]>[0];

/**
 * One resource a Host can request from the Account Holder. AutoSigning
 * currently returns `NotAvailable` on both Android and iOS wallets.
 */
export type AllocatableResource = ResourceAllocationRequest["resources"][number];

/**
 * `"Ignore"`: return existing keys if any, else allocate one slot.
 * `"Increase"`: add one slot to an existing allowance account.
 */
export type OnExistingAllowancePolicy = ResourceAllocationRequest["onExisting"];

type ExtractOk<R> = R extends ResultAsync<infer T, unknown> ? T : never;

/**
 * Per-resource outcome. `Allocated.value` carries the materialized payload
 * (slot account key for Bulletin/SSS; subtree key + secret for AutoSigning;
 * undefined for SC). Each entry is independent — no rollback on partial
 * success.
 */
export type ApAllocationOutcome = ExtractOk<
    ReturnType<UserSession["requestResourceAllocation"]>
>[number];

export interface RequestResourceAllocationOptions {
    /**
     * Override the auto-picked `onExisting`. Default: `Ignore` unless every
     * requested resource is a cached slot-table variant, then `Increase`.
     */
    onExisting?: OnExistingAllowancePolicy;
}

/**
 * Send the AP `request_resource_allocation` message over the paired
 * session; block on the user's mobile dialog; return outcomes in request
 * order. Granted key material is cached on disk so subsequent calls skip
 * the wallet prompt.
 *
 * @throws If the session call fails (transport, timeout, AH protocol error).
 *
 * @example
 * ```ts
 * const [session] = adapter.sessions.sessions.read();
 * const outcomes = await requestResourceAllocation(session, adapter, [
 *   { tag: "BulletInAllowance", value: undefined },
 * ]);
 * ```
 */
export async function requestResourceAllocation(
    session: UserSession,
    adapter: TerminalAdapter,
    resources: AllocatableResource[],
    options: RequestResourceAllocationOptions = {},
): Promise<ApAllocationOutcome[]> {
    return withCacheLock(adapter.appId, adapter.storageDir, async () => {
        const cache = await loadCache(adapter.appId, adapter.storageDir);
        const onExisting = options.onExisting ?? pickOnExistingPolicy(cache, resources);
        log.debug("requestResourceAllocation", {
            productId: adapter.appId,
            resources: resources.map((r) => r.tag),
            onExisting,
            autoPolicy: options.onExisting === undefined,
        });

        const result = await session.requestResourceAllocation({
            callingProductId: adapter.appId,
            resources,
            onExisting,
        });

        if (result.isErr()) {
            throw new Error(`requestResourceAllocation failed: ${result.error.message}`);
        }

        const next = mergeOutcomes(cache, resources, result.value);
        if (next !== cache) {
            await saveCache(adapter.appId, next, adapter.storageDir);
        }

        return result.value;
    });
}

/**
 * Read a cached allowance entry without going over the wire. Returns
 * `null` if nothing's cached for `(adapter.appId, resource)`. For
 * `SmartContractAllowance`, the same `dest` must be passed — entries
 * are keyed per-dest.
 */
export async function getCachedAllocation(
    adapter: TerminalAdapter,
    resource: AllocatableResource,
): Promise<CachedAllocation | null> {
    const cache = await loadCache(adapter.appId, adapter.storageDir);
    return readCacheEntry(cache, resource);
}

/**
 * Cache hit → return signer. Cache miss → call
 * {@link requestResourceAllocation} for `[resource]`, then build the signer.
 * Throws on `Rejected` / `NotAvailable`.
 *
 * @example
 * ```ts
 * const signer = await ensureSlotAccountSigner(session, adapter, {
 *   tag: "BulletInAllowance", value: undefined,
 * });
 * await someBulletinTx.submitAndWatch(signer);
 * ```
 */
export async function ensureSlotAccountSigner(
    session: UserSession,
    adapter: TerminalAdapter,
    resource: AllocatableResource,
): Promise<PolkadotSigner> {
    // The cache-hit check and the allocation path must share the same
    // critical section: otherwise two concurrent calls for the same
    // resource both see an empty cache, then both serialize through the
    // lock but each issues its own wallet prompt and burns a slot.
    return withCacheLock(adapter.appId, adapter.storageDir, async () => {
        // Single loadCache for the whole critical section — we hold the
        // lock, so no other writer can change disk under us. The fast
        // cache-hit path and the slow allocate-then-build path both
        // reuse this in-memory `cache` reference.
        const cache = await loadCache(adapter.appId, adapter.storageDir);
        const hit = readCacheEntry(cache, resource);
        if (hit) return buildSignerFromEntry(hit);

        log.debug("ensureSlotAccountSigner: cache miss, allocating", { resource: resource.tag });

        // Inline the wire → merge → save sequence rather than calling the
        // public `requestResourceAllocation` wrapper. `withCacheLock` is
        // non-reentrant, so calling the wrapper from inside would deadlock
        // on the second lock acquisition.
        const onExisting = pickOnExistingPolicy(cache, [resource]);
        const result = await session.requestResourceAllocation({
            callingProductId: adapter.appId,
            resources: [resource],
            onExisting,
        });
        if (result.isErr()) {
            throw new Error(`requestResourceAllocation failed: ${result.error.message}`);
        }
        const outcomes = result.value;
        const next = mergeOutcomes(cache, [resource], outcomes);
        if (next !== cache) {
            await saveCache(adapter.appId, next, adapter.storageDir);
        }

        const outcome = outcomes[0];
        if (!outcome) {
            // Unreachable: mergeOutcomes throws on length mismatch first.
            // Kept as a typed-non-null guard.
            throw new Error(
                `ensureSlotAccountSigner: protocol violation — empty outcomes for ${resource.tag}`,
            );
        }
        if (outcome.tag !== "Allocated") {
            throw new Error(
                `ensureSlotAccountSigner: allocation ${outcome.tag} for ${resource.tag}`,
            );
        }

        // Build the signer from the in-memory post-merge cache — no third
        // disk read.
        const freshEntry = readCacheEntry(next, resource);
        if (!freshEntry) {
            // Unreachable: the entry was just merged in.
            // Kept as a typed-non-null guard against mergeOutcomes regressions.
            throw new Error(
                `ensureSlotAccountSigner: allocation succeeded but cache lookup returned null for ${resource.tag}`,
            );
        }
        return buildSignerFromEntry(freshEntry);
    });
}

if (import.meta.vitest) {
    const { describe, test, expect, vi, beforeEach } = import.meta.vitest;
    const { ok, err } = await import("neverthrow");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");
    // Needed by the ensureSlotAccountSigner suite. Lifted up here because
    // top-level await is only allowed at module top-level (or inside this
    // top-level vitest block), not inside `describe`.
    const { mnemonicToMiniSecret, DEV_PHRASE } = await import("@polkadot-labs/hdkd-helpers");
    const { toHex } = await import("@polkadot-api/utils");

    let testStorageDir: string;
    beforeEach(() => {
        // Per-test temp dir so cache writes don't leak between tests or
        // touch the real default storage directory. The wrapper inherits
        // `storageDir` from `adapter.storageDir`; we pin it here.
        testStorageDir = mkdtempSync(pathJoin(tmpdir(), "host-test-"));
        return () => rmSync(testStorageDir, { recursive: true, force: true });
    });

    function fakeAdapter(appId: string): TerminalAdapter {
        // appId + storageDir are the only fields the wrapper touches.
        return { appId, storageDir: testStorageDir } as unknown as TerminalAdapter;
    }

    type RequestCapture = ResourceAllocationRequest;
    type StubReturn = Awaited<ReturnType<UserSession["requestResourceAllocation"]>>;

    function makeSession(opts: {
        requestResourceAllocation?: (req: RequestCapture) => Promise<StubReturn>;
    }): UserSession {
        return {
            requestResourceAllocation: vi.fn(
                opts.requestResourceAllocation ??
                    (async () => {
                        throw new Error("requestResourceAllocation not stubbed in this test");
                    }),
            ),
        } as unknown as UserSession;
    }

    describe("requestResourceAllocation", () => {
        test("forwards resources verbatim and returns outcomes in order", async () => {
            const captured: RequestCapture[] = [];
            const stubbed = [
                {
                    tag: "Allocated" as const,
                    value: {
                        tag: "BulletInAllowance" as const,
                        value: { slotAccountKey: new Uint8Array([1, 2, 3]) },
                    },
                },
                { tag: "Rejected" as const, value: undefined },
            ];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return ok(stubbed) as StubReturn;
                },
            });

            const outcomes = await requestResourceAllocation(session, fakeAdapter("my-app"), [
                { tag: "BulletInAllowance", value: undefined },
                { tag: "StatementStoreAllowance", value: undefined },
            ]);

            expect(captured).toHaveLength(1);
            expect(captured[0].callingProductId).toBe("my-app");
            expect(captured[0].resources.map((r) => r.tag)).toEqual([
                "BulletInAllowance",
                "StatementStoreAllowance",
            ]);
            expect(outcomes).toEqual(stubbed);
        });

        test("uses adapter.appId as callingProductId", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return ok([]) as StubReturn;
                },
            });

            await requestResourceAllocation(session, fakeAdapter("alt-product.dot"), []);

            expect(captured[0].callingProductId).toBe("alt-product.dot");
        });

        test("auto-picks Ignore for an empty resources array", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return ok([]) as StubReturn;
                },
            });

            await requestResourceAllocation(session, fakeAdapter("p"), []);

            expect(captured[0].onExisting).toBe("Ignore");
        });

        test("forwards onExisting when explicitly set to 'Increase'", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return ok([{ tag: "Rejected" as const, value: undefined }]) as StubReturn;
                },
            });

            await requestResourceAllocation(
                session,
                fakeAdapter("p"),
                [{ tag: "BulletInAllowance", value: undefined }],
                { onExisting: "Increase" },
            );

            expect(captured[0].onExisting).toBe("Increase");
        });

        test("forwards SmartContractAllowance derivation index", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return ok([{ tag: "Rejected" as const, value: undefined }]) as StubReturn;
                },
            });

            await requestResourceAllocation(session, fakeAdapter("p"), [
                { tag: "SmartContractAllowance", value: 7 },
            ]);

            const sent = captured[0].resources[0];
            expect(sent.tag).toBe("SmartContractAllowance");
            if (sent.tag === "SmartContractAllowance") {
                expect(sent.value).toBe(7);
            }
        });

        test("throws a clear error when the session call fails", async () => {
            const session = makeSession({
                requestResourceAllocation: async () =>
                    err(new Error("mobile disconnected")) as StubReturn,
            });

            await expect(
                requestResourceAllocation(session, fakeAdapter("p"), [
                    { tag: "BulletInAllowance", value: undefined },
                ]),
            ).rejects.toThrow("requestResourceAllocation failed: mobile disconnected");
        });

        test("forwards AutoSigning and returns NotAvailable verbatim (mobile-default path)", async () => {
            // Both Android (paritytech/polkadot-app-android-v2#563) and iOS
            // (paritytech/polkadot-app-ios-v2#759) currently return NotAvailable
            // for any AutoSigning request. The wrapper must round-trip both
            // the request variant and the NotAvailable outcome without
            // filtering, transforming, or throwing — that's the only state
            // real users see for one of the four AllocatableResource variants
            // today.
            const captured: RequestCapture[] = [];
            const stubbed = [{ tag: "NotAvailable" as const, value: undefined }];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return ok(stubbed) as StubReturn;
                },
            });

            const outcomes = await requestResourceAllocation(session, fakeAdapter("p"), [
                { tag: "AutoSigning", value: undefined },
            ]);

            const sent = captured[0].resources[0];
            expect(sent.tag).toBe("AutoSigning");
            expect(outcomes).toEqual(stubbed);
        });

        test("passes empty resources through (no-op request still hits the wire)", async () => {
            // Wrappers shouldn't second-guess the caller: an empty resource
            // list is a legitimate (if degenerate) request and the wire
            // accepts it. The Account Holder may use it as a probe.
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return ok([]) as StubReturn;
                },
            });

            const outcomes = await requestResourceAllocation(session, fakeAdapter("p"), []);

            expect(captured).toHaveLength(1);
            expect(captured[0].resources).toEqual([]);
            expect(outcomes).toEqual([]);
        });
    });

    describe("requestResourceAllocation — cache integration", () => {
        function bulletinAllocated(slotKey: Uint8Array): StubReturn {
            return ok([
                {
                    tag: "Allocated" as const,
                    value: {
                        tag: "BulletInAllowance" as const,
                        value: { slotAccountKey: slotKey },
                    },
                },
            ]) as StubReturn;
        }

        test("first call sends Ignore when cache is empty", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return bulletinAllocated(new Uint8Array([1, 2, 3]));
                },
            });

            await requestResourceAllocation(session, fakeAdapter("p"), [
                { tag: "BulletInAllowance", value: undefined },
            ]);

            expect(captured[0].onExisting).toBe("Ignore");
        });

        test("second call for same slot-table resource auto-picks Increase", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return bulletinAllocated(new Uint8Array([1, 2, 3]));
                },
            });

            const adapter = fakeAdapter("p");
            const req: AllocatableResource[] = [{ tag: "BulletInAllowance", value: undefined }];

            await requestResourceAllocation(session, adapter, req);
            await requestResourceAllocation(session, adapter, req);

            expect(captured.map((c) => c.onExisting)).toEqual(["Ignore", "Increase"]);
        });

        test("explicit options.onExisting overrides the auto-pick", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return bulletinAllocated(new Uint8Array([1, 2, 3]));
                },
            });

            const adapter = fakeAdapter("p");
            const req: AllocatableResource[] = [{ tag: "BulletInAllowance", value: undefined }];

            // Even after a cache-populating first call, passing Ignore
            // explicitly forces Ignore — useful for callers that want
            // idempotent "ensure I have allowance" semantics rather than
            // the additive-scaling default.
            await requestResourceAllocation(session, adapter, req);
            await requestResourceAllocation(session, adapter, req, { onExisting: "Ignore" });

            expect(captured.map((c) => c.onExisting)).toEqual(["Ignore", "Ignore"]);
        });

        test("populates cache on Allocated and survives across separate calls", async () => {
            const slotKey = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
            const session = makeSession({
                requestResourceAllocation: async () => bulletinAllocated(slotKey),
            });

            const adapter = fakeAdapter("p");
            await requestResourceAllocation(session, adapter, [
                { tag: "BulletInAllowance", value: undefined },
            ]);

            // Second call reads cache via the public lookup, no wire.
            const cached = await getCachedAllocation(adapter, {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(cached).toEqual({
                tag: "BulletInAllowance",
                slotAccountKey: "0xdeadbeef",
            });
        });

        test("does not cache Rejected or NotAvailable outcomes", async () => {
            const session = makeSession({
                requestResourceAllocation: async () =>
                    ok([
                        { tag: "Rejected" as const, value: undefined },
                        { tag: "NotAvailable" as const, value: undefined },
                    ]) as StubReturn,
            });

            const adapter = fakeAdapter("p");
            await requestResourceAllocation(session, adapter, [
                { tag: "BulletInAllowance", value: undefined },
                { tag: "StatementStoreAllowance", value: undefined },
            ]);

            expect(
                await getCachedAllocation(adapter, { tag: "BulletInAllowance", value: undefined }),
            ).toBeNull();
            expect(
                await getCachedAllocation(adapter, {
                    tag: "StatementStoreAllowance",
                    value: undefined,
                }),
            ).toBeNull();
        });

        test("mixed cached + uncached request stays on Ignore (conservative)", async () => {
            // Bulletin cached, SSS not. Auto-pick must NOT send Increase
            // — the wire takes one policy for the whole request, and
            // Increase against an uncached resource is at-best a no-op
            // and at-worst a mis-allocation.
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    // Length-match the request: 1 or 2 outcomes as needed.
                    return ok(
                        req.resources.map((_r, i) =>
                            i === 0
                                ? {
                                      tag: "Allocated" as const,
                                      value: {
                                          tag: "BulletInAllowance" as const,
                                          value: { slotAccountKey: new Uint8Array([1]) },
                                      },
                                  }
                                : { tag: "Rejected" as const, value: undefined },
                        ),
                    ) as StubReturn;
                },
            });

            const adapter = fakeAdapter("p");
            // Populate Bulletin in cache.
            await requestResourceAllocation(session, adapter, [
                { tag: "BulletInAllowance", value: undefined },
            ]);

            // Now request both Bulletin (cached) and SSS (uncached).
            await requestResourceAllocation(session, adapter, [
                { tag: "BulletInAllowance", value: undefined },
                { tag: "StatementStoreAllowance", value: undefined },
            ]);

            expect(captured[captured.length - 1].onExisting).toBe("Ignore");
        });

        test("AutoSigning never auto-Increases even when cached", async () => {
            // AutoSigning isn't slot-additive; auto-pick must stay on Ignore.
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return ok([
                        {
                            tag: "Allocated" as const,
                            value: {
                                tag: "AutoSigning" as const,
                                value: {
                                    productDerivationSecret: "secret",
                                    productRootPrivateKey: new Uint8Array([0xab]),
                                },
                            },
                        },
                    ]) as StubReturn;
                },
            });

            const adapter = fakeAdapter("p");
            const req: AllocatableResource[] = [{ tag: "AutoSigning", value: undefined }];

            await requestResourceAllocation(session, adapter, req);
            await requestResourceAllocation(session, adapter, req);

            expect(captured.map((c) => c.onExisting)).toEqual(["Ignore", "Ignore"]);
        });

        test("parallel calls for different resources both persist their keys (no last-writer-wins)", async () => {
            // Regression test for the load → wire → save race: without
            // serialization, both calls snapshot an empty cache, do their
            // wire round-trip, then save — the second save clobbers the
            // first. Both keys must end up in the cache.
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    // Force interleaving: each call yields before responding.
                    await new Promise((r) => setTimeout(r, 5));
                    const tag = req.resources[0]?.tag;
                    return ok([
                        {
                            tag: "Allocated" as const,
                            value:
                                tag === "BulletInAllowance"
                                    ? {
                                          tag: "BulletInAllowance" as const,
                                          value: { slotAccountKey: new Uint8Array([0xaa]) },
                                      }
                                    : {
                                          tag: "StatementStoreAllowance" as const,
                                          value: { slotAccountKey: new Uint8Array([0xbb]) },
                                      },
                        },
                    ]) as StubReturn;
                },
            });
            const adapter = fakeAdapter("p");

            await Promise.all([
                requestResourceAllocation(session, adapter, [
                    { tag: "BulletInAllowance", value: undefined },
                ]),
                requestResourceAllocation(session, adapter, [
                    { tag: "StatementStoreAllowance", value: undefined },
                ]),
            ]);

            expect(
                await getCachedAllocation(adapter, {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
            ).not.toBeNull();
            expect(
                await getCachedAllocation(adapter, {
                    tag: "StatementStoreAllowance",
                    value: undefined,
                }),
            ).not.toBeNull();
        });

        test("two appIds maintain independent caches in the same storageDir", async () => {
            const session = makeSession({
                requestResourceAllocation: async () => bulletinAllocated(new Uint8Array([1, 2, 3])),
            });

            const adapterA = fakeAdapter("app-a");
            const adapterB = fakeAdapter("app-b");

            await requestResourceAllocation(session, adapterA, [
                { tag: "BulletInAllowance", value: undefined },
            ]);

            // app-b's cache is empty even though app-a's is populated.
            expect(
                await getCachedAllocation(adapterB, {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
            ).toBeNull();
            expect(
                await getCachedAllocation(adapterA, {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
            ).not.toBeNull();
        });
    });

    describe("getCachedAllocation", () => {
        test("returns null when nothing is cached", async () => {
            const adapter = fakeAdapter("p");
            const cached = await getCachedAllocation(adapter, {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(cached).toBeNull();
        });

        test("disambiguates SmartContractAllowance entries by dest", async () => {
            const session = makeSession({
                requestResourceAllocation: async () =>
                    ok([
                        {
                            tag: "Allocated" as const,
                            value: {
                                tag: "SmartContractAllowance" as const,
                                value: undefined,
                            },
                        },
                    ]) as StubReturn,
            });
            const adapter = fakeAdapter("p");
            await requestResourceAllocation(session, adapter, [
                { tag: "SmartContractAllowance", value: 5 },
            ]);

            expect(
                await getCachedAllocation(adapter, { tag: "SmartContractAllowance", value: 5 }),
            ).toEqual({ tag: "SmartContractAllowance", dest: 5 });
            // Different dest doesn't match.
            expect(
                await getCachedAllocation(adapter, { tag: "SmartContractAllowance", value: 6 }),
            ).toBeNull();
        });
    });

    describe("ensureSlotAccountSigner", () => {
        // Deterministic mini-secret so the signer is constructable.
        const slotKey = mnemonicToMiniSecret(DEV_PHRASE);

        function bulletinAllocatedResponse() {
            return ok([
                {
                    tag: "Allocated" as const,
                    value: {
                        tag: "BulletInAllowance" as const,
                        value: { slotAccountKey: slotKey },
                    },
                },
            ]) as StubReturn;
        }

        test("cache hit returns a signer without invoking the AP wire", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return bulletinAllocatedResponse();
                },
            });
            const adapter = fakeAdapter("p");

            // Populate cache.
            await requestResourceAllocation(session, adapter, [
                { tag: "BulletInAllowance", value: undefined },
            ]);
            expect(captured).toHaveLength(1);

            // ensureSlotAccountSigner should find the cached key and NOT
            // call the wire again.
            const signer = await ensureSlotAccountSigner(session, adapter, {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(signer.publicKey).toBeInstanceOf(Uint8Array);
            expect(captured).toHaveLength(1); // still 1 — no extra round-trip
        });

        test("cache miss triggers allocation and returns a fresh signer", async () => {
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    return bulletinAllocatedResponse();
                },
            });
            const adapter = fakeAdapter("p");

            // No prior call. ensureSlotAccountSigner should round-trip.
            const signer = await ensureSlotAccountSigner(session, adapter, {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(signer.publicKey).toBeInstanceOf(Uint8Array);
            expect(captured).toHaveLength(1);
            // Implicit allocation requests exactly one resource.
            expect(captured[0].resources.map((r) => r.tag)).toEqual(["BulletInAllowance"]);
        });

        test("Rejected outcome surfaces as a throw — no signer to return", async () => {
            const session = makeSession({
                requestResourceAllocation: async () =>
                    ok([{ tag: "Rejected" as const, value: undefined }]) as StubReturn,
            });

            await expect(
                ensureSlotAccountSigner(session, fakeAdapter("p"), {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
            ).rejects.toThrow(/allocation Rejected for BulletInAllowance/);
        });

        test("empty outcomes array from the wire surfaces as a length-mismatch throw", async () => {
            // mergeOutcomes enforces the length contract and throws before
            // the downstream `outcomes[0]` defensive guard is reached.
            const session = makeSession({
                requestResourceAllocation: async () => ok([]) as StubReturn,
            });

            await expect(
                ensureSlotAccountSigner(session, fakeAdapter("p"), {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
            ).rejects.toThrow(/length mismatch — requested 1, got 0/);
        });

        test("NotAvailable outcome surfaces as a throw", async () => {
            const session = makeSession({
                requestResourceAllocation: async () =>
                    ok([{ tag: "NotAvailable" as const, value: undefined }]) as StubReturn,
            });

            await expect(
                ensureSlotAccountSigner(session, fakeAdapter("p"), {
                    tag: "StatementStoreAllowance",
                    value: undefined,
                }),
            ).rejects.toThrow(/allocation NotAvailable for StatementStoreAllowance/);
        });

        test("transport error propagates from the underlying allocation call", async () => {
            const session = makeSession({
                requestResourceAllocation: async () =>
                    err(new Error("mobile timed out")) as StubReturn,
            });

            await expect(
                ensureSlotAccountSigner(session, fakeAdapter("p"), {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
            ).rejects.toThrow(/mobile timed out/);
        });

        test("populates the cache so a later call is a hit", async () => {
            const session = makeSession({
                requestResourceAllocation: async () => bulletinAllocatedResponse(),
            });
            const adapter = fakeAdapter("p");

            await ensureSlotAccountSigner(session, adapter, {
                tag: "BulletInAllowance",
                value: undefined,
            });

            // After the implicit allocation, getCachedAllocation should see the key.
            const cached = await getCachedAllocation(adapter, {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(cached?.tag).toBe("BulletInAllowance");
        });

        test("parallel calls for the SAME resource share one allocation (no double-prompt)", async () => {
            // Regression: previously the cache-hit check ran outside the
            // lock, so two concurrent same-resource calls both passed it,
            // then both hit the wire under the serialized lock — burning
            // two slots and prompting the wallet twice. Both calls must
            // resolve from a single allocation.
            const captured: RequestCapture[] = [];
            const session = makeSession({
                requestResourceAllocation: async (req) => {
                    captured.push(req);
                    // Force a yield so the second caller has a chance to
                    // race past the cache check if the lock isn't around it.
                    await new Promise((r) => setTimeout(r, 5));
                    return bulletinAllocatedResponse();
                },
            });
            const adapter = fakeAdapter("p");

            const [signerA, signerB] = await Promise.all([
                ensureSlotAccountSigner(session, adapter, {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
                ensureSlotAccountSigner(session, adapter, {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
            ]);

            // Exactly one wire round-trip — the second caller must observe
            // the freshly-cached key, not start a second allocation.
            expect(captured).toHaveLength(1);
            // Both calls return functioning signers backed by the same key.
            expect(signerA.publicKey).toBeInstanceOf(Uint8Array);
            expect(signerB.publicKey).toBeInstanceOf(Uint8Array);
            expect(toHex(signerA.publicKey)).toBe(toHex(signerB.publicKey));
        });
    });
}
