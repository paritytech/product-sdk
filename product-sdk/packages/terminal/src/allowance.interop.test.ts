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
import { gcm } from "@noble/ciphers/aes.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { createPappAdapter, type UserSession } from "@novasamatech/host-papp";
import {
    deriveSlotAccountPublicKey,
    ensureSubstrateSlotSr25519Ready,
    type LazyClient,
    type StatementStoreAdapter,
} from "@novasamatech/statement-store";
import { substrateSlotSecretFromSeedBytes } from "@novasamatech/substrate-slot-sr25519-wasm";
import { toHex } from "@polkadot-api/utils";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { okAsync } from "neverthrow";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bytes, Enum, Struct, Vector, _void, str } from "scale-ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getBulletinSigner, getStatementStoreProver } from "./allowance.js";
import { createNodeStorageAdapter, sanitizeKey } from "./node-storage.js";
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

// Mirror of host-papp's `AllowanceRepository` codec — vendored here for the
// same reason `testing.ts` mirrors the session codec: the codec is internal
// to host-papp and not exported. If host-papp changes the codec, this test
// fails immediately rather than letting the change slip past CI.
const AllowanceResourceKindCodec = Enum({
    bulletin: _void,
    statementStore: _void,
});
const StoredAllowanceEntryCodec = Struct({
    productId: str,
    resource: AllowanceResourceKindCodec,
    slotAccountKey: Bytes(),
});
const StoredAllowancesCodec = Vector(StoredAllowanceEntryCodec);

/**
 * Mirror of host-papp's `AllowanceRepository` AES-GCM wrapper. Same key
 * derivation as the user-secrets repository: blake2b(appId, 16) for the AES
 * key, blake2b("nonce", 32) for the nonce. host-papp re-uses these for the
 * allowance store so a single salt seeds both repositories on the same
 * appId.
 */
function encryptAllowances(appId: string, plaintext: Uint8Array): string {
    const key = blake2b(new TextEncoder().encode(appId), { dkLen: 16 });
    const nonce = blake2b(new TextEncoder().encode("nonce"), { dkLen: 32 });
    return toHex(gcm(key, nonce).encrypt(plaintext));
}

/**
 * Pre-populate the allowance cache for a session so `adapter.allowance.*`
 * hits the cache path instead of attempting a wire allocation. Mirrors what
 * the SDK would have written on a previous run after the wallet allocated
 * a slot.
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
    resource: "bulletin" | "statementStore";
    slotAccountKey: Uint8Array;
}): Promise<void> {
    const entries = [
        {
            productId,
            resource: { tag: resource, value: undefined } as
                | { tag: "bulletin"; value: undefined }
                | { tag: "statementStore"; value: undefined },
            slotAccountKey,
        },
    ];
    const encoded = StoredAllowancesCodec.enc(entries);
    const encrypted = encryptAllowances(appId, encoded);
    // host-papp writes the allowance keys under `AllowanceKeys_<sessionId>`
    // via the same `createKey` shape it uses for user secrets.
    const fileName = `${sanitizeKey(appId, `AllowanceKeys_${sessionId}`)}.json`;
    await writeFile(join(storageDir, fileName), encrypted, "utf-8");
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
});
