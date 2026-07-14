// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Convenience wrappers around `adapter.allowance` for CLI consumers.
 *
 * The host-papp `AllowanceService` (exposed as `adapter.allowance`) returns
 * neverthrow `ResultAsync` values and requires the caller to pass a
 * `sessionId` explicitly. CLIs almost always run with one paired session at
 * a time, so passing `sessionId` is redundant and the neverthrow envelope
 * doesn't fit the rest of `@parity/product-sdk-terminal`'s throwy/async
 * idiom (`createSessionSigner`, `requestResourceAllocation`).
 *
 * These helpers:
 *  - default the `sessionId` to the single paired session when there's
 *    exactly one (the common CLI case);
 *  - unwrap the `ResultAsync` into a `Promise<T>` that throws an
 *    {@link AllowanceError} on failure;
 *  - leave the underlying `adapter.allowance` intact for callers who want
 *    explicit multi-session handling or neverthrow's `.match` ergonomics.
 *
 * @module
 */
import { AllowanceError } from "@novasamatech/host-papp";
import type { StatementProver } from "@novasamatech/statement-store";
import type { PolkadotSigner } from "polkadot-api";

import type { TerminalAdapter } from "./adapter.js";
import { type AllowanceResourceKind, readStoredAllowances } from "./allowance-cache.js";

/**
 * Pick the session id to use for an allowance request, defaulting to the
 * single paired session when no explicit id is supplied.
 *
 * @throws {AllowanceError} `NoSession` when zero sessions or `>1` sessions
 *   are paired without an explicit id — both cases are ambiguous and the
 *   caller should resolve them before calling the convenience.
 */
function resolveSessionId(adapter: TerminalAdapter, sessionId?: string): string {
    if (sessionId) return sessionId;
    const sessions = adapter.sessions.sessions.read();
    if (sessions.length === 0) {
        // Same error class host-papp emits internally so catch-by-instanceof
        // handlers behave identically for both paths.
        throw new AllowanceError("NoSession", "No paired session — pair a phone first.");
    }
    if (sessions.length > 1) {
        throw new AllowanceError(
            "NoSession",
            `Multiple paired sessions (${sessions.length}) — pass an explicit sessionId.`,
        );
    }
    return sessions[0]!.id;
}

/**
 * Get a `PolkadotSigner` for a Bulletin allowance slot.
 *
 * Allocates an allowance slot via the paired wallet (or returns the cached
 * one), derives the slot-account keypair, and returns a `PolkadotSigner`
 * that signs Bulletin extrinsics with it. Replaces the manual
 * `requestResourceAllocation` + `createSlotAccountSigner` two-step for the
 * common case.
 *
 * @param adapter Terminal adapter.
 * @param productId The product id the slot is allocated under. Passed to the
 *   host as the calling product id in the allowance request.
 * @param sessionId Paired session to allocate against. Defaults to the only
 *   paired session; throws `AllowanceError('NoSession')` when zero or more
 *   than one sessions are paired and no explicit id is supplied.
 * @throws {AllowanceError} On rejection, missing session, host-side failure,
 *   or unexpected response shape.
 *
 * @example
 * ```ts
 * import { createTerminalAdapter, getBulletinSigner } from "@parity/product-sdk-terminal";
 *
 * const adapter = createTerminalAdapter({ appId: "my-cli" });
 * // ... QR pair, wait for session ...
 * const signer = await getBulletinSigner(adapter, "my-cli.dot");
 * await client.bulletin.tx.TransactionStorage.store({ data }).signAndSubmit(signer);
 * ```
 */
export async function getBulletinSigner(
    adapter: TerminalAdapter,
    productId: string,
    sessionId?: string,
): Promise<PolkadotSigner> {
    const resolvedSessionId = resolveSessionId(adapter, sessionId);
    return adapter.allowance.getBulletinSigner(resolvedSessionId, productId).match(
        (signer) => signer,
        (err) => {
            throw err;
        },
    );
}

/**
 * Get a `StatementProver` for a statement-store allowance slot.
 *
 * Allocates an allowance slot via the paired wallet (or returns the cached
 * one) and returns the upstream `StatementProver` for the slot. Use when
 * publishing statements through `@novasamatech/statement-store` without
 * holding a long-lived key yourself.
 *
 * @param adapter Terminal adapter.
 * @param productId The product id the slot is allocated under.
 * @param sessionId Paired session to allocate against. Defaults to the only
 *   paired session; throws `AllowanceError('NoSession')` when zero or more
 *   than one sessions are paired and no explicit id is supplied.
 * @throws {AllowanceError} On rejection, missing session, host-side failure,
 *   or unexpected response shape.
 */
export async function getStatementStoreProver(
    adapter: TerminalAdapter,
    productId: string,
    sessionId?: string,
): Promise<StatementProver> {
    const resolvedSessionId = resolveSessionId(adapter, sessionId);
    return adapter.allowance.getStatementStoreProver(resolvedSessionId, productId).match(
        (prover) => prover,
        (err) => {
            throw err;
        },
    );
}

/**
 * Cache-only probe: read host-papp's encrypted on-disk allowance list and
 * resolve to whether an entry exists for `(sessionId, productId, resource)`.
 *
 * Never invokes `requestResourceAllocation`, so this is safe to call from
 * paths that must not prompt the paired wallet (e.g. login health checks).
 * Resolves `false` for: file absent, file present with no entry for the
 * tuple. Rejects only on decrypt / decode failures — a corrupted cache
 * file is a real failure that should not silently degrade into "no
 * allowance."
 *
 * Reads the file at `<storageDir>/<appId>_AllowanceKeys_<sessionId>.json`
 * — same path host-papp writes to from its `AllowanceRepository`. The
 * decode is via a vendored mirror of host-papp's internal codec; see
 * `allowance-cache.ts` for drift-detection guards.
 */
async function hasAllowanceForResource(
    adapter: TerminalAdapter,
    productId: string,
    resource: AllowanceResourceKind,
    sessionId?: string,
): Promise<boolean> {
    const resolvedSessionId = resolveSessionId(adapter, sessionId);
    if (adapter.storageDir === undefined) {
        // The on-disk cache only exists when the adapter knows where its files
        // live. Without an explicit `storageDir` the production host-papp
        // backend may write through a non-disk storage adapter that this
        // helper can't read; we conservatively answer false so callers don't
        // skip pairing on a missed cache.
        return false;
    }
    const entries = await readStoredAllowances(
        adapter.storageDir,
        adapter.appId,
        resolvedSessionId,
    );
    return entries.some(
        (entry) => entry.productId === productId && entry.resource.tag === resource,
    );
}

/**
 * Cache-only probe for a Bulletin allowance slot. Resolves `true` when a
 * slot key for `(sessionId, productId, bulletin)` is already cached on
 * disk; `false` when it is not. Never prompts the paired wallet.
 *
 * Pair with {@link getBulletinSigner} for the "check first, fetch only
 * if needed" flow:
 *
 * @example
 * ```ts
 * if (await hasBulletinAllowance(adapter, "my-cli.dot")) {
 *     // happy path — fetch the signer without risking a wallet prompt
 *     const signer = await getBulletinSigner(adapter, "my-cli.dot");
 * } else {
 *     // tell the user a wallet prompt will fire, then call getBulletinSigner
 * }
 * ```
 */
export async function hasBulletinAllowance(
    adapter: TerminalAdapter,
    productId: string,
    sessionId?: string,
): Promise<boolean> {
    return hasAllowanceForResource(adapter, productId, "bulletin", sessionId);
}

/**
 * Cache-only probe for a Statement Store allowance slot. Resolves `true`
 * when a slot key for `(sessionId, productId, statementStore)` is already
 * cached on disk; `false` when it is not. Never prompts the paired wallet.
 *
 * Pair with {@link getStatementStoreProver} for the "check first, fetch
 * only if needed" flow.
 */
export async function hasStatementStoreAllowance(
    adapter: TerminalAdapter,
    productId: string,
    sessionId?: string,
): Promise<boolean> {
    return hasAllowanceForResource(adapter, productId, "statementStore", sessionId);
}

// ── vitest in-source tests ─────────────────────────────────────────────────
if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;
    const { ok, err } = await import("neverthrow");

    type FakeSession = { id: string };

    function makeAdapter(opts: {
        sessions: FakeSession[];
        getBulletinSigner?: ReturnType<typeof vi.fn>;
        getStatementStoreProver?: ReturnType<typeof vi.fn>;
    }): TerminalAdapter {
        return {
            sessions: {
                sessions: {
                    read: () => opts.sessions,
                },
            },
            allowance: {
                getBulletinSigner: opts.getBulletinSigner ?? vi.fn(() => ok({})),
                getStatementStoreProver: opts.getStatementStoreProver ?? vi.fn(() => ok({})),
            },
            // The convenience never touches the rest of the adapter; leave it unstubbed.
        } as unknown as TerminalAdapter;
    }

    describe("getBulletinSigner — sessionId defaulting", () => {
        test("uses the only paired session when sessionId is omitted", async () => {
            const fakeSigner = { _tag: "signer" };
            const getBulletinSignerFn = vi.fn(() => ok(fakeSigner));
            const adapter = makeAdapter({
                sessions: [{ id: "sess-only" }],
                getBulletinSigner: getBulletinSignerFn,
            });

            const result = await getBulletinSigner(adapter, "my-app.dot");
            expect(result).toBe(fakeSigner);
            expect(getBulletinSignerFn).toHaveBeenCalledWith("sess-only", "my-app.dot");
        });

        test("uses the explicit sessionId when supplied", async () => {
            const fakeSigner = { _tag: "signer" };
            const getBulletinSignerFn = vi.fn(() => ok(fakeSigner));
            const adapter = makeAdapter({
                sessions: [{ id: "sess-a" }, { id: "sess-b" }],
                getBulletinSigner: getBulletinSignerFn,
            });

            await getBulletinSigner(adapter, "my-app.dot", "sess-b");
            expect(getBulletinSignerFn).toHaveBeenCalledWith("sess-b", "my-app.dot");
        });

        test("throws AllowanceError('NoSession') when zero sessions and no id", async () => {
            const adapter = makeAdapter({ sessions: [] });
            await expect(getBulletinSigner(adapter, "my-app.dot")).rejects.toBeInstanceOf(
                AllowanceError,
            );
            await expect(getBulletinSigner(adapter, "my-app.dot")).rejects.toMatchObject({
                reason: "NoSession",
            });
        });

        test("throws AllowanceError('NoSession') when multiple sessions and no id", async () => {
            const adapter = makeAdapter({ sessions: [{ id: "a" }, { id: "b" }] });
            await expect(getBulletinSigner(adapter, "my-app.dot")).rejects.toBeInstanceOf(
                AllowanceError,
            );
            await expect(getBulletinSigner(adapter, "my-app.dot")).rejects.toMatchObject({
                reason: "NoSession",
            });
        });
    });

    describe("getBulletinSigner — error unwrapping", () => {
        test("rethrows the AllowanceError from the underlying service as a thrown exception", async () => {
            const underlyingErr = new AllowanceError("Rejected", "user said no");
            const adapter = makeAdapter({
                sessions: [{ id: "s" }],
                getBulletinSigner: vi.fn(() => err(underlyingErr)),
            });
            // The wrapper rethrows the original error instance — handlers
            // catching by `instanceof AllowanceError` see the same object the
            // underlying service produced.
            await expect(getBulletinSigner(adapter, "p")).rejects.toBe(underlyingErr);
        });
    });

    describe("getStatementStoreProver — same defaulting", () => {
        test("uses the only paired session when sessionId is omitted", async () => {
            const fakeProver = { _tag: "prover" };
            const getStatementStoreProverFn = vi.fn(() => ok(fakeProver));
            const adapter = makeAdapter({
                sessions: [{ id: "sess-only" }],
                getStatementStoreProver: getStatementStoreProverFn,
            });

            const result = await getStatementStoreProver(adapter, "my-app.dot");
            expect(result).toBe(fakeProver);
            expect(getStatementStoreProverFn).toHaveBeenCalledWith("sess-only", "my-app.dot");
        });

        test("uses the explicit sessionId when supplied", async () => {
            const fakeProver = { _tag: "prover" };
            const getStatementStoreProverFn = vi.fn(() => ok(fakeProver));
            const adapter = makeAdapter({
                sessions: [{ id: "sess-a" }, { id: "sess-b" }],
                getStatementStoreProver: getStatementStoreProverFn,
            });

            await getStatementStoreProver(adapter, "my-app.dot", "sess-b");
            expect(getStatementStoreProverFn).toHaveBeenCalledWith("sess-b", "my-app.dot");
        });

        test("throws AllowanceError('NoSession') when zero sessions and no id", async () => {
            const adapter = makeAdapter({ sessions: [] });
            await expect(getStatementStoreProver(adapter, "my-app.dot")).rejects.toBeInstanceOf(
                AllowanceError,
            );
            await expect(getStatementStoreProver(adapter, "my-app.dot")).rejects.toMatchObject({
                reason: "NoSession",
            });
        });

        test("throws AllowanceError('NoSession') when multiple sessions and no id", async () => {
            const adapter = makeAdapter({ sessions: [{ id: "a" }, { id: "b" }] });
            await expect(getStatementStoreProver(adapter, "my-app.dot")).rejects.toBeInstanceOf(
                AllowanceError,
            );
            await expect(getStatementStoreProver(adapter, "my-app.dot")).rejects.toMatchObject({
                reason: "NoSession",
            });
        });
    });

    describe("getStatementStoreProver — error unwrapping", () => {
        test("rethrows the AllowanceError from the underlying service as a thrown exception", async () => {
            const underlyingErr = new AllowanceError("Rejected", "user said no");
            const adapter = makeAdapter({
                sessions: [{ id: "s" }],
                getStatementStoreProver: vi.fn(() => err(underlyingErr)),
            });
            await expect(getStatementStoreProver(adapter, "p")).rejects.toBe(underlyingErr);
        });
    });

    describe("has*Allowance — sessionId defaulting + storageDir fallback", () => {
        // Cache-hit / cache-miss against real disk + the host-papp codec are
        // covered by `allowance.interop.test.ts`. These unit tests cover the
        // branches that don't reach the filesystem.

        test("hasBulletinAllowance throws AllowanceError('NoSession') when zero sessions and no id", async () => {
            const adapter = makeAdapter({ sessions: [] });
            await expect(hasBulletinAllowance(adapter, "p")).rejects.toBeInstanceOf(AllowanceError);
            await expect(hasBulletinAllowance(adapter, "p")).rejects.toMatchObject({
                reason: "NoSession",
            });
        });

        test("hasBulletinAllowance returns false (conservative) when storageDir is undefined", async () => {
            // Production: a TerminalAdapter without an explicit storageDir
            // may be backed by a non-disk StorageAdapter that this helper
            // can't read. Returning false avoids the trap of "we report
            // 'no allowance cached' confidently when we just couldn't read."
            const adapter = makeAdapter({ sessions: [{ id: "sess-only" }] });
            // Mock has no storageDir field — the helper should short-circuit.
            expect(await hasBulletinAllowance(adapter, "p")).toBe(false);
        });

        test("hasStatementStoreAllowance throws AllowanceError('NoSession') when zero sessions and no id", async () => {
            const adapter = makeAdapter({ sessions: [] });
            await expect(hasStatementStoreAllowance(adapter, "p")).rejects.toBeInstanceOf(
                AllowanceError,
            );
        });

        test("hasStatementStoreAllowance returns false (conservative) when storageDir is undefined", async () => {
            const adapter = makeAdapter({ sessions: [{ id: "sess-only" }] });
            expect(await hasStatementStoreAllowance(adapter, "p")).toBe(false);
        });
    });
}
