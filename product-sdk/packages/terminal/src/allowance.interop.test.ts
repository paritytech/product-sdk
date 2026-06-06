// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Interop test for the allowance convenience wrappers.
 *
 * Drives `getBulletinSigner` / `getStatementStoreProver` end-to-end through:
 *   - our session id defaulting (`resolveSessionId`),
 *   - host-papp's real `AllowanceService`,
 *   - host-papp's real `AllowanceRepository` (decrypting + decoding a
 *     synthesized cache entry on disk),
 *   - host-papp's slot-account derivation (`deriveSlotAccountPublicKey`).
 *
 * A cache hit is the path we exercise here — we pre-write an encrypted
 * `AllowanceKeys_<sessionId>.json` file using the same AES-GCM scheme
 * host-papp uses for the user-secrets repository, so the allowance service
 * finds a cached slot key and never reaches out to the (non-existent)
 * paired wallet. That covers the steady-state CLI behaviour. Cache-miss
 * + real wallet round-trip can only be exercised by a manual smoke test
 * against a phone.
 */
import { createPappAdapter, type UserSession } from "@novasamatech/host-papp";
import {
    deriveSlotAccountPublicKey,
    ensureSubstrateSlotSr25519Ready,
    type LazyClient,
    type StatementStoreAdapter,
} from "@novasamatech/statement-store";
import { substrateSlotSecretFromSeedBytes } from "@novasamatech/substrate-slot-sr25519-wasm";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { okAsync } from "neverthrow";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
    getBulletinSigner,
    getStatementStoreProver,
    hasBulletinAllowance,
    hasStatementStoreAllowance,
} from "./allowance.js";
import { type AllowanceResourceKind, writeStoredAllowances } from "./allowance-cache.js";
import { createNodeStorageAdapter } from "./node-storage.js";
import { createTestSession } from "./testing.js";

const APP_ID = "allowance-interop";
const LOCAL_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const REMOTE_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PRODUCT_ID = "allowance-interop.dot";

// Deterministic 64-byte slot account secret seed. The actual slot secret
// is derived via `substrateSlotSecretFromSeedBytes` inside the test (which
// requires the WASM to be initialised first). The official slot-WASM test
// helper produces the canonical Substrate `Keypair::to_bytes()` form
// (scalar || nonce) — an arbitrary Uint8Array(64) is rejected as "high-bit set".
const SLOT_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const SLOT_SECRET_SEED = entropyToMiniSecret(mnemonicToEntropy(SLOT_MNEMONIC));

/**
 * Pre-populate the allowance cache for a session so `adapter.allowance.*`
 * hits the cache path instead of attempting a wire allocation. Thin wrapper
 * over the shared `writeStoredAllowances` helper from `allowance-cache.ts`.
 */
async function seedAllowanceCache({
    storageDir,
    appId,
    sessionId,
    productId,
    resource,
    slotAccountKey,
}: {
    storageDir: string;
    appId: string;
    sessionId: string;
    productId: string;
    resource: AllowanceResourceKind;
    slotAccountKey: Uint8Array;
}): Promise<void> {
    await writeStoredAllowances(storageDir, appId, sessionId, [
        { productId, resource: { tag: resource, value: undefined }, slotAccountKey },
    ]);
}

// Shim adapters mirroring `testing.interop.test.ts` — none of these are
// consulted on the cache-hit path, but `createTerminalAdapter` requires them
// for construction.
const neverCalled = () => {
    throw new Error("test shim — should not be called");
};
const statementStoreShim: StatementStoreAdapter = {
    queryStatements: () => okAsync([]),
    subscribeStatements: () => () => {},
    submitStatement: () => okAsync(undefined),
};
const lazyClientShim: LazyClient = {
    getClient: neverCalled,
    getRequestFn: () => neverCalled,
    getSubscribeFn: () => neverCalled,
    disconnect: () => {},
} as unknown as LazyClient;

function waitForFirstSession(
    adapter: ReturnType<typeof createPappAdapter>,
    timeoutMs = 5000,
): Promise<UserSession> {
    return new Promise((resolve, reject) => {
        const unsub = adapter.sessions.sessions.subscribe((sessions: UserSession[]) => {
            if (sessions.length > 0) {
                unsub();
                resolve(sessions[0]!);
            }
        });
        setTimeout(() => {
            unsub();
            reject(new Error(`No session emitted within ${timeoutMs}ms`));
        }, timeoutMs);
    });
}

describe("allowance helpers — interop with the real host-papp AllowanceService", () => {
    let storageDir: string;
    let fakeSlotSecret: Uint8Array;

    beforeEach(async () => {
        storageDir = await mkdtemp(join(tmpdir(), "allowance-interop-"));
        // Slot-account derivation goes through the substrate-slot-sr25519
        // WASM module — make sure it's initialised before deriving the slot
        // secret (and any signer derivation in the tests below).
        await ensureSubstrateSlotSr25519Ready();
        fakeSlotSecret = substrateSlotSecretFromSeedBytes(SLOT_SECRET_SEED);
    });

    afterEach(async () => {
        await rm(storageDir, { recursive: true, force: true });
    });

    test("getBulletinSigner returns a PolkadotSigner whose pubkey matches the cached slot account", async () => {
        const { sessionId } = await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });

        await seedAllowanceCache({
            storageDir,
            appId: APP_ID,
            sessionId,
            productId: PRODUCT_ID,
            resource: "bulletin",
            slotAccountKey: fakeSlotSecret,
        });

        // `createPappAdapter` directly — same shape `createTerminalAdapter`
        // wires up, but with test shims for the network-dependent pieces so
        // the cache-hit path doesn't try to reach a real RPC or wallet.
        const pappAdapter = createPappAdapter({
            appId: APP_ID,
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                lazyClient: lazyClientShim,
            },
        });

        // Wait for the persisted session to surface so adapter.sessions.read()
        // is non-empty when the convenience defaults its sessionId.
        await waitForFirstSession(pappAdapter);

        // Hand the pappAdapter to the convenience as a TerminalAdapter
        // (structurally compatible; the convenience only reads
        // `sessions.sessions.read()` and `allowance`).
        const terminalAdapter = pappAdapter as unknown as Parameters<typeof getBulletinSigner>[0];
        const signer = await getBulletinSigner(terminalAdapter, PRODUCT_ID);

        // The convenience defaulted sessionId to the only paired session,
        // host-papp's AllowanceService hit the cache, decoded our seeded
        // entry, derived a signer over the slot key. publicKey on the
        // returned PolkadotSigner must equal the slot-account public key
        // derived from our fakeSlotSecret — proves the cache reached
        // the signer without re-deriving from a wallet round-trip.
        const expectedPubKey = deriveSlotAccountPublicKey(fakeSlotSecret);
        expect(signer.publicKey).toEqual(expectedPubKey);

        pappAdapter.sessions.dispose();
    });

    test("getStatementStoreProver returns a prover for the cached statementStore slot", async () => {
        const { sessionId } = await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });

        await seedAllowanceCache({
            storageDir,
            appId: APP_ID,
            sessionId,
            productId: PRODUCT_ID,
            resource: "statementStore",
            slotAccountKey: fakeSlotSecret,
        });

        const pappAdapter = createPappAdapter({
            appId: APP_ID,
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                lazyClient: lazyClientShim,
            },
        });

        await waitForFirstSession(pappAdapter);
        const terminalAdapter = pappAdapter as unknown as Parameters<
            typeof getStatementStoreProver
        >[0];
        const prover = await getStatementStoreProver(terminalAdapter, PRODUCT_ID);

        // StatementProver's public surface is `generateMessageProof` /
        // `verifyMessageProof`. Asserting both are callable proves the
        // wrapper unwrapped a real prover from the underlying ResultAsync
        // (not a stub or shape mismatch).
        expect(typeof prover.generateMessageProof).toBe("function");
        expect(typeof prover.verifyMessageProof).toBe("function");

        pappAdapter.sessions.dispose();
    });

    // ── Cache-only probes ──────────────────────────────────────────────────
    //
    // hasBulletinAllowance / hasStatementStoreAllowance read host-papp's
    // encrypted AllowanceKeys file directly via the codec mirror in
    // `allowance-cache.ts`. The interop test asserts the mirror's decode
    // round-trips against a cache entry the SDK would have written: we use
    // the shared `writeStoredAllowances` (encode + AES-GCM encrypt + write)
    // to seed, then assert `has*Allowance` reads it back as `true`.
    //
    // Because the production code reads `adapter.appId` and `adapter.storageDir`
    // (fields on `TerminalAdapter` but not `PappAdapter`), the cast object
    // here augments the bare `PappAdapter` with both. The other adapter
    // fields aren't touched by these helpers.

    test("hasBulletinAllowance returns true when a slot key for the tuple is cached", async () => {
        const { sessionId } = await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });
        await seedAllowanceCache({
            storageDir,
            appId: APP_ID,
            sessionId,
            productId: PRODUCT_ID,
            resource: "bulletin",
            slotAccountKey: fakeSlotSecret,
        });

        const pappAdapter = createPappAdapter({
            appId: APP_ID,
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                lazyClient: lazyClientShim,
            },
        });
        await waitForFirstSession(pappAdapter);
        const terminalAdapter = Object.assign(pappAdapter, {
            appId: APP_ID,
            storageDir,
        }) as unknown as Parameters<typeof hasBulletinAllowance>[0];

        expect(await hasBulletinAllowance(terminalAdapter, PRODUCT_ID)).toBe(true);

        pappAdapter.sessions.dispose();
    });

    test("hasBulletinAllowance returns false when no slot key is cached", async () => {
        await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });
        // Critically: no seedAllowanceCache call. The session exists but no
        // allowance has been allocated for it yet.

        const pappAdapter = createPappAdapter({
            appId: APP_ID,
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                lazyClient: lazyClientShim,
            },
        });
        await waitForFirstSession(pappAdapter);
        const terminalAdapter = Object.assign(pappAdapter, {
            appId: APP_ID,
            storageDir,
        }) as unknown as Parameters<typeof hasBulletinAllowance>[0];

        expect(await hasBulletinAllowance(terminalAdapter, PRODUCT_ID)).toBe(false);

        pappAdapter.sessions.dispose();
    });

    test("hasBulletinAllowance returns false when the cached entry is for a different productId", async () => {
        const { sessionId } = await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });
        // Seed an entry for a DIFFERENT product — we're asserting `hasAllowance`
        // matches on productId, not just any entry under the session.
        await seedAllowanceCache({
            storageDir,
            appId: APP_ID,
            sessionId,
            productId: "some-other.dot",
            resource: "bulletin",
            slotAccountKey: fakeSlotSecret,
        });

        const pappAdapter = createPappAdapter({
            appId: APP_ID,
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                lazyClient: lazyClientShim,
            },
        });
        await waitForFirstSession(pappAdapter);
        const terminalAdapter = Object.assign(pappAdapter, {
            appId: APP_ID,
            storageDir,
        }) as unknown as Parameters<typeof hasBulletinAllowance>[0];

        expect(await hasBulletinAllowance(terminalAdapter, PRODUCT_ID)).toBe(false);

        pappAdapter.sessions.dispose();
    });

    test("hasBulletinAllowance returns true after getBulletinSigner has populated the cache (login-readiness flow)", async () => {
        // End-to-end-style: the exact sequence a CLI login health check
        // would hit on a second run. First call (`getBulletinSigner`)
        // pulls a slot key through host-papp's real AllowanceService and
        // writes the encrypted `AllowanceKeys_<sessionId>.json` file.
        // Second call (`hasBulletinAllowance`) reads that same file via
        // the codec mirror in `allowance-cache.ts` and must report `true`
        // without prompting a wallet. Catches drift between what
        // host-papp writes and what our probe reads — the one place
        // byte-level disagreement matters for the cache-only API.
        const { sessionId } = await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });
        await seedAllowanceCache({
            storageDir,
            appId: APP_ID,
            sessionId,
            productId: PRODUCT_ID,
            resource: "bulletin",
            slotAccountKey: fakeSlotSecret,
        });

        const pappAdapter = createPappAdapter({
            appId: APP_ID,
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                lazyClient: lazyClientShim,
            },
        });
        await waitForFirstSession(pappAdapter);
        const terminalAdapter = Object.assign(pappAdapter, {
            appId: APP_ID,
            storageDir,
        }) as unknown as Parameters<typeof hasBulletinAllowance>[0];

        // Step 1 — fetch the signer. This is the prompt-allowed path; on a
        // cache hit (which we have, via seedAllowanceCache) host-papp re-
        // reads + re-writes the same file. Asserting the pubkey matches
        // confirms the signer actually came from the cached slot key.
        const signer = await getBulletinSigner(terminalAdapter, PRODUCT_ID);
        expect(signer.publicKey).toEqual(deriveSlotAccountPublicKey(fakeSlotSecret));

        // Step 2 — the cache-only probe must agree. If the codec mirror in
        // `allowance-cache.ts` ever drifts from what host-papp writes,
        // this assertion flips to `false` and we catch it here rather
        // than in production.
        expect(await hasBulletinAllowance(terminalAdapter, PRODUCT_ID)).toBe(true);

        pappAdapter.sessions.dispose();
    });

    test("hasStatementStoreAllowance distinguishes resource kinds for the same productId", async () => {
        const { sessionId } = await createTestSession({
            appId: APP_ID,
            storageDir,
            localMnemonic: LOCAL_MNEMONIC,
            remoteMnemonic: REMOTE_MNEMONIC,
        });
        // Seed a bulletin entry, then query for statementStore — same product,
        // different resource. The check must distinguish them.
        await seedAllowanceCache({
            storageDir,
            appId: APP_ID,
            sessionId,
            productId: PRODUCT_ID,
            resource: "bulletin",
            slotAccountKey: fakeSlotSecret,
        });

        const pappAdapter = createPappAdapter({
            appId: APP_ID,
            adapters: {
                storage: createNodeStorageAdapter(APP_ID, storageDir),
                statementStore: statementStoreShim,
                lazyClient: lazyClientShim,
            },
        });
        await waitForFirstSession(pappAdapter);
        const terminalAdapter = Object.assign(pappAdapter, {
            appId: APP_ID,
            storageDir,
        }) as unknown as Parameters<typeof hasStatementStoreAllowance>[0];

        // Bulletin: present.
        expect(await hasBulletinAllowance(terminalAdapter, PRODUCT_ID)).toBe(true);
        // StatementStore: not present.
        expect(await hasStatementStoreAllowance(terminalAdapter, PRODUCT_ID)).toBe(false);

        pappAdapter.sessions.dispose();
    });
});
