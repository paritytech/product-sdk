/**
 * Interop test for `createTestSession`.
 *
 * Confirms that a session synthesized by the test helper round-trips through
 * the real `@novasamatech/host-papp` session repositories — a
 * `TerminalAdapter` reading from the same storage directory must emit the
 * synthesized session from `adapter.sessions.sessions` and decrypt the
 * corresponding secrets via `adapter.secrets.read`.
 *
 * If `@novasamatech/host-papp` ever changes the on-disk codec or encryption
 * scheme, this test fails and signals that `src/testing.ts` needs to follow.
 */
import { createPappAdapter } from "@novasamatech/host-papp";
import type { UserSession } from "@novasamatech/host-papp";
import type { LazyClient, StatementStoreAdapter } from "@novasamatech/statement-store";
import { errAsync, okAsync } from "neverthrow";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createNodeStorageAdapter } from "./node-storage.js";
import { createTestSession } from "./testing.js";

const APP_ID = "interop-test";
const LOCAL_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const REMOTE_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Shim adapters. The session-loader path creates an inner statement-store
// session per persisted user session, which eagerly calls `queryStatements`
// to replay any pre-existing protocol state. Returning an empty list lets
// that init complete without a real peer.
const neverCalled = () => {
    throw new Error("test shim — should not be called");
};
const statementStoreShim: StatementStoreAdapter = {
    queryStatements: () => okAsync([]),
    subscribeStatements: () => () => {},
    submitStatement: () => okAsync(undefined),
};
const identityShim = {
    readIdentities: () => errAsync(new Error("test shim")),
};
// `createPappAdapter` only reaches the lazy client if we don't supply a
// `statementStore` / `identities` — we do supply shims for both, so none of
// these methods actually run during the test. The cast collapses the
// heavier return-type of `createLazyClient` (which includes polkadot-api
// client surface) to what the test actually wires up.
const lazyClientShim: LazyClient = {
    getClient: neverCalled,
    getRequestFn: () => neverCalled,
    getSubscribeFn: () => neverCalled,
    disconnect: () => {},
} as unknown as LazyClient;

describe("createTestSession interop with host-papp", () => {
    let storageDir: string;

    beforeEach(async () => {
        storageDir = await mkdtemp(join(tmpdir(), "terminal-interop-"));
    });

    afterEach(async () => {
        await rm(storageDir, { recursive: true, force: true });
    });

    test("synthesized session is emitted by the real SsoSessionManager", async () => {
        const { sessionId, localAccountId, remoteAccountId } = await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });

        const adapter = createPappAdapter({
            appId: APP_ID,
            metadata: "https://example.com/metadata.json",
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                identities: identityShim,
                lazyClient: lazyClientShim,
            },
        });

        const session = await waitForFirstSession(adapter);
        expect(session.id).toBe(sessionId);
        expect(new Uint8Array(session.localAccount.accountId)).toEqual(localAccountId);
        expect(new Uint8Array(session.remoteAccount.accountId)).toEqual(remoteAccountId);

        adapter.sessions.dispose();
    });

    test("synthesized secrets decrypt via the real UserSecretRepository", async () => {
        const { sessionId } = await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });

        const adapter = createPappAdapter({
            appId: APP_ID,
            metadata: "https://example.com/metadata.json",
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                identities: identityShim,
                lazyClient: lazyClientShim,
            },
        });

        const result = await adapter.secrets.read(sessionId);
        expect(result.isOk()).toBe(true);
        const secrets = result._unsafeUnwrap();
        expect(secrets).not.toBeNull();
        expect(secrets!.entropy).toBeInstanceOf(Uint8Array);
        expect(secrets!.ssSecret).toBeInstanceOf(Uint8Array);
        expect(secrets!.encrSecret).toBeInstanceOf(Uint8Array);

        adapter.sessions.dispose();
    });

    test("no session is emitted when only UserSecrets file exists", async () => {
        // Baseline sanity: an empty storage dir yields no sessions from the
        // real manager either. Guards against the loader silently emitting
        // spurious empty-array sessions that would pass waitForSessions().
        const adapter = createPappAdapter({
            appId: APP_ID,
            metadata: "https://example.com/metadata.json",
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                identities: identityShim,
                lazyClient: lazyClientShim,
            },
        });

        const sessions = await collectSessions(adapter, 100);
        expect(sessions).toEqual([]);

        adapter.sessions.dispose();
    });
});

function waitForFirstSession(
    adapter: ReturnType<typeof createPappAdapter>,
    timeoutMs = 2000,
): Promise<UserSession> {
    return new Promise((resolve, reject) => {
        const unsub = adapter.sessions.sessions.subscribe((sessions) => {
            if (sessions.length > 0) {
                unsub();
                clearTimeout(timer);
                resolve(sessions[0]);
            }
        });
        const timer = setTimeout(() => {
            unsub();
            reject(new Error(`No session emitted within ${timeoutMs}ms`));
        }, timeoutMs);
    });
}

function collectSessions(
    adapter: ReturnType<typeof createPappAdapter>,
    settleMs: number,
): Promise<UserSession[]> {
    return new Promise((resolve) => {
        let latest: UserSession[] = [];
        const unsub = adapter.sessions.sessions.subscribe((sessions) => {
            latest = sessions;
        });
        setTimeout(() => {
            unsub();
            resolve(latest);
        }, settleMs);
    });
}
