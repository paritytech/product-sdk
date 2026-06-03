// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test helpers for synthesizing persisted sessions.
 *
 * Production sessions are persisted to the storage directory by
 * `createNodeStorageAdapter` in the SCALE-encoded / AES-GCM-encrypted
 * format defined by `@novasamatech/host-papp`'s internal repositories.
 * There is no public API on the adapter to write a session without going
 * through the QR pairing + on-chain attestation flow, which makes E2E
 * testing of session-dependent CLI flows impossible without a real phone.
 *
 * This module mirrors that format using only public primitives, so E2E
 * tests can inject a known-good session file. The `testing.test.ts`
 * integration test reads the synthesized files back through the real
 * `ssoSessionRepository` + `userSecretRepository` from `@novasamatech/host-papp`
 * and fails if the upstream format ever drifts from our reproduction.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { blake2b } from "@noble/hashes/blake2.js";
import {
    AccountIdCodec,
    LocalSessionAccountCodec,
    RemoteSessionAccountCodec,
    createAccountId,
    createLocalSessionAccount,
    createRemoteSessionAccount,
    createSr25519Secret,
    deriveSr25519PublicKey,
} from "@novasamatech/statement-store";
import { toHex } from "@polkadot-api/utils";
import {
    entropyToMiniSecret,
    generateMnemonic,
    mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { Bytes, type Codec, Option, Struct, Vector, str } from "scale-ts";
import type { StoredUserSession } from "@novasamatech/host-papp";

import { sanitizeKey } from "./node-storage.js";

// Mirror of host-papp's internal stored-session codec (not exported — only the
// `StoredUserSession` type is). `satisfies` guards drift at build time, the
// interop test at runtime; field order and the `Bytes(65)` chat key must match.
const storedUserSessionCodec = Struct({
    id: str,
    localAccount: LocalSessionAccountCodec,
    remoteAccount: RemoteSessionAccountCodec,
    rootAccountId: AccountIdCodec,
    identityAccountId: Option(AccountIdCodec),
    identityChatPublicKey: Option(Bytes(65)),
}) satisfies Codec<StoredUserSession>;
const sessionsCodec = Vector(storedUserSessionCodec);

// Mirrors the internal StoredUserSecretsCodec in host-papp's userSecretRepository.
const storedUserSecretsCodec = Struct({
    ssSecret: Bytes(),
    encrSecret: Bytes(),
    entropy: Bytes(),
});

// Mirrors host-papp's userSecretRepository AES-GCM wrapper: the encryption
// key is blake2b(appId, 16) and the nonce is blake2b("nonce", 32). The appId
// doubles as the salt, so sessions written by this helper are only readable
// by a TerminalAdapter configured with the same appId.
function encryptSecrets(appId: string, plaintext: Uint8Array): string {
    const key = blake2b(new TextEncoder().encode(appId), { dkLen: 16 });
    const nonce = blake2b(new TextEncoder().encode("nonce"), { dkLen: 32 });
    return toHex(gcm(key, nonce).encrypt(plaintext));
}

/** Mirrors host-papp's createEncrSecret: pad the mini-secret to 48 bytes and feed it to P256 keygen. */
function p256SecretFromEntropy(entropy: Uint8Array): Uint8Array {
    const seed = new Uint8Array(48);
    seed.set(entropyToMiniSecret(entropy));
    return p256.keygen(seed).secretKey;
}

export interface CreateTestSessionOptions {
    /** Unique app identifier. Must match the one passed to `createTerminalAdapter`. */
    appId: string;
    /**
     * Directory where session files are written. Must match the one the
     * CLI reads from — pass the same value to `createTerminalAdapter`'s
     * `storageDir` option.
     */
    storageDir: string;
    /** BIP39 mnemonic for the local (host-side) account. Default: freshly generated. */
    localMnemonic?: string;
    /** Derivation path for the local account. Default: `"//wallet//sso"` (matches production). */
    localDerivation?: string;
    /** BIP39 mnemonic for the remote (phone) account. Default: freshly generated. */
    remoteMnemonic?: string;
    /** Derivation path for the remote account. Default: `""`. */
    remoteDerivation?: string;
    /** Stable session id. Default: random nanoid(12). */
    sessionId?: string;
    /**
     * Whether to write the encrypted `UserSecrets_<id>` file. Default: `true`.
     * Set to `false` to exercise recovery paths where a session exists on disk
     * but its secrets are missing.
     */
    includeSecrets?: boolean;
}

export interface TestSession {
    sessionId: string;
    /** Sr25519 public key of the local (host) account, 32 bytes. */
    localAccountId: Uint8Array;
    /** Sr25519 public key of the remote (phone) account, 32 bytes. */
    remoteAccountId: Uint8Array;
    localMnemonic: string;
    localDerivation: string;
    remoteMnemonic: string;
    remoteDerivation: string;
}

/**
 * Write a valid persisted session to `storageDir`, as if the user had
 * completed QR pairing + attestation. A `TerminalAdapter` created with the
 * same `appId` + `storageDir` will emit the synthesized session from
 * `adapter.sessions.sessions`.
 *
 * @remarks
 * **Dev utility — not a stable contract.** This helper hand-rolls SCALE codecs
 * that mirror an internal on-disk format used by `@novasamatech/host-papp`'s
 * session repositories. The format is not part of host-papp's documented public
 * API and may change on minor version bumps. The `testing.interop.test.ts`
 * round-trip test fails loudly when the format drifts. Use this only in test code.
 *
 * ## Limits
 *
 * - **Signing does not round-trip.** Sending a request via `session.signRaw`
 *   still goes out over the statement store and expects a real phone to
 *   respond. Use this helper for flows that test session discovery,
 *   persistence, and logout — not end-to-end signing.
 * - **Signing attempts surface `NoAllowanceError`.** The synthesized local
 *   account was never registered on the People chain, so the first write
 *   to the statement store fails with `NoAllowanceError`. That's the same
 *   error path the CLI sees when a previously valid session's on-chain
 *   attestation has expired, so tests that assert "CLI handles an expired
 *   session" *can* be written against a synthesized session even though
 *   there's no `expiresAt` knob to turn.
 * - **No `expiresAt`.** The on-disk codec has no expiry field; validity is
 *   tracked via on-chain attestation state. See above for how expiry-path
 *   tests still work in practice.
 * - **Corrupted-session cases** don't need a helper — write garbage to
 *   `<storageDir>/<appId>_SsoSessions.json` with `fs.writeFile` directly.
 * - **Repeated calls replace the session list.** Each call writes a fresh
 *   single-entry `SsoSessions` file, so calling twice on the same
 *   `storageDir`+`appId` leaves only the second session on disk. Use a
 *   fresh `mkdtempSync` per test to keep cases isolated.
 *
 * @example
 * ```ts
 * import { mkdtempSync } from "node:fs";
 * import { tmpdir } from "node:os";
 * import { join } from "node:path";
 * import { createTestSession } from "@parity/product-sdk-terminal/testing";
 * import { createTerminalAdapter, waitForSessions } from "@parity/product-sdk-terminal";
 *
 * const storageDir = mkdtempSync(join(tmpdir(), "e2e-"));
 * const { sessionId } = await createTestSession({ appId: "dot-cli", storageDir });
 *
 * const adapter = createTerminalAdapter({ appId: "dot-cli", storageDir });
 * const sessions = await waitForSessions(adapter);
 * // sessions[0].id === sessionId
 * ```
 */
export async function createTestSession(options: CreateTestSessionOptions): Promise<TestSession> {
    await mkdir(options.storageDir, { recursive: true });

    const localMnemonic = options.localMnemonic ?? generateMnemonic();
    const localDerivation = options.localDerivation ?? "//wallet//sso";
    const localEntropy = mnemonicToEntropy(localMnemonic);
    const localSecret = createSr25519Secret(localEntropy, localDerivation);
    const localPublicKey = deriveSr25519PublicKey(localSecret);
    const localEncrSecret = p256SecretFromEntropy(localEntropy);

    const remoteMnemonic = options.remoteMnemonic ?? generateMnemonic();
    const remoteDerivation = options.remoteDerivation ?? "";
    const remoteEntropy = mnemonicToEntropy(remoteMnemonic);
    const remoteSecret = createSr25519Secret(remoteEntropy, remoteDerivation);
    const remotePublicKey = deriveSr25519PublicKey(remoteSecret);
    const remoteEncrPublicKey = p256.getPublicKey(p256SecretFromEntropy(remoteEntropy), false);

    // In production, `remoteAccount.publicKey` is the ECDH shared secret
    // between the host's P256 encryption key and the phone's P256 encryption
    // key. We compute the same thing from two mnemonic-derived P256 keys so
    // the synthesized session is cryptographically well-formed.
    const sharedSecret = p256.getSharedSecret(localEncrSecret, remoteEncrPublicKey).slice(1, 33);

    const sessionId = options.sessionId ?? nanoid(12);

    const session = {
        id: sessionId,
        localAccount: createLocalSessionAccount(createAccountId(localPublicKey), undefined),
        remoteAccount: createRemoteSessionAccount(
            createAccountId(remotePublicKey),
            sharedSecret,
            undefined,
        ),
        // synthesized session: the remote (wallet) account doubles as root.
        rootAccountId: createAccountId(remotePublicKey),
        identityAccountId: undefined,
        identityChatPublicKey: undefined,
    };

    await writeFile(
        join(options.storageDir, `${sanitizeKey(options.appId, "SsoSessions")}.json`),
        toHex(sessionsCodec.enc([session])),
        "utf-8",
    );

    const includeSecrets = options.includeSecrets ?? true;
    if (includeSecrets) {
        const encoded = storedUserSecretsCodec.enc({
            ssSecret: localSecret,
            encrSecret: localEncrSecret,
            entropy: localEntropy,
        });
        await writeFile(
            join(
                options.storageDir,
                `${sanitizeKey(options.appId, `UserSecrets_${sessionId}`)}.json`,
            ),
            encryptSecrets(options.appId, encoded),
            "utf-8",
        );
    }

    return {
        sessionId,
        localAccountId: localPublicKey,
        remoteAccountId: remotePublicKey,
        localMnemonic,
        localDerivation,
        remoteMnemonic,
        remoteDerivation,
    };
}

if (import.meta.vitest) {
    const { describe, test, expect, beforeEach, afterAll } = import.meta.vitest;
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { fromHex } = await import("@polkadot-api/utils");

    // Stable dev mnemonics — deterministic inputs keep the tests hermetic.
    // The first is the well-known Substrate dev root (the source of `//Alice`
    // et al.); the second is the BIP39 all-abandon test vector.
    const LOCAL_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
    const REMOTE_MNEMONIC =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    let storageDir: string;

    beforeEach(async () => {
        storageDir = await mkdtemp(join(tmpdir(), "terminal-testing-"));
    });

    afterAll(async () => {
        try {
            await rm(storageDir, { recursive: true });
        } catch {
            /* ignore */
        }
    });

    describe("createTestSession", () => {
        test("writes both SsoSessions and UserSecrets files by default", async () => {
            const result = await createTestSession({
                appId: "my-app",
                storageDir,
                localMnemonic: LOCAL_MNEMONIC,
                remoteMnemonic: REMOTE_MNEMONIC,
            });

            const sessions = await readFile(join(storageDir, "my-app_SsoSessions.json"), "utf-8");
            expect(sessions).toMatch(/^0x[0-9a-f]+$/);

            const secrets = await readFile(
                join(storageDir, `my-app_UserSecrets_${result.sessionId}.json`),
                "utf-8",
            );
            expect(secrets).toMatch(/^0x[0-9a-f]+$/);
        });

        test("omits UserSecrets file when includeSecrets is false", async () => {
            const result = await createTestSession({
                appId: "my-app",
                storageDir,
                localMnemonic: LOCAL_MNEMONIC,
                remoteMnemonic: REMOTE_MNEMONIC,
                includeSecrets: false,
            });

            await expect(
                readFile(join(storageDir, "my-app_SsoSessions.json"), "utf-8"),
            ).resolves.toMatch(/^0x/);

            await expect(
                readFile(join(storageDir, `my-app_UserSecrets_${result.sessionId}.json`), "utf-8"),
            ).rejects.toThrow(/ENOENT/);
        });

        test("SsoSessions file decodes with the host-papp session codec shape", async () => {
            const result = await createTestSession({
                appId: "my-app",
                storageDir,
                localMnemonic: LOCAL_MNEMONIC,
                remoteMnemonic: REMOTE_MNEMONIC,
                sessionId: "stable-test-id",
            });

            const hex = await readFile(join(storageDir, "my-app_SsoSessions.json"), "utf-8");
            const decoded = sessionsCodec.dec(fromHex(hex));

            expect(decoded).toHaveLength(1);
            expect(decoded[0].id).toBe("stable-test-id");
            expect(decoded[0].localAccount.accountId).toEqual(result.localAccountId);
            expect(decoded[0].localAccount.pin).toBeUndefined();
            expect(decoded[0].remoteAccount.accountId).toEqual(result.remoteAccountId);
            expect(decoded[0].remoteAccount.publicKey).toHaveLength(32);
            expect(decoded[0].remoteAccount.pin).toBeUndefined();
        });

        test("localAccountId matches the Sr25519 public key derived from the mnemonic", async () => {
            const result = await createTestSession({
                appId: "my-app",
                storageDir,
                localMnemonic: LOCAL_MNEMONIC,
                remoteMnemonic: REMOTE_MNEMONIC,
            });

            const expected = deriveSr25519PublicKey(
                createSr25519Secret(mnemonicToEntropy(LOCAL_MNEMONIC), "//wallet//sso"),
            );
            expect(result.localAccountId).toEqual(expected);
            expect(result.localAccountId).toHaveLength(32);
        });

        test("UserSecrets file decrypts and decodes with the host-papp secret codec shape", async () => {
            const appId = "my-app";
            const result = await createTestSession({
                appId,
                storageDir,
                localMnemonic: LOCAL_MNEMONIC,
                remoteMnemonic: REMOTE_MNEMONIC,
            });

            const hex = await readFile(
                join(storageDir, `${appId}_UserSecrets_${result.sessionId}.json`),
                "utf-8",
            );
            const key = blake2b(new TextEncoder().encode(appId), { dkLen: 16 });
            const nonce = blake2b(new TextEncoder().encode("nonce"), { dkLen: 32 });
            const decrypted = gcm(key, nonce).decrypt(fromHex(hex));
            const decoded = storedUserSecretsCodec.dec(decrypted);

            expect(decoded.entropy).toEqual(mnemonicToEntropy(LOCAL_MNEMONIC));
            // Sr25519 secret is 64 bytes (32-byte secret + 32-byte nonce).
            expect(decoded.ssSecret).toHaveLength(64);
            // P256 secret is 32 bytes.
            expect(decoded.encrSecret).toHaveLength(32);
        });

        test("different appIds produce files under different prefixes", async () => {
            await createTestSession({ appId: "app-a", storageDir, sessionId: "id" });
            await createTestSession({ appId: "app-b", storageDir, sessionId: "id" });

            await expect(
                readFile(join(storageDir, "app-a_SsoSessions.json"), "utf-8"),
            ).resolves.toMatch(/^0x/);
            await expect(
                readFile(join(storageDir, "app-b_SsoSessions.json"), "utf-8"),
            ).resolves.toMatch(/^0x/);
        });

        test("sanitizes appIds with special characters", async () => {
            await createTestSession({
                appId: "app/with spaces",
                storageDir,
                sessionId: "id",
            });
            await expect(
                readFile(join(storageDir, "app_with_spaces_SsoSessions.json"), "utf-8"),
            ).resolves.toMatch(/^0x/);
        });

        test("creates storageDir when it does not yet exist", async () => {
            const nested = join(storageDir, "does", "not", "exist");
            await createTestSession({ appId: "my-app", storageDir: nested });
            await expect(
                readFile(join(nested, "my-app_SsoSessions.json"), "utf-8"),
            ).resolves.toMatch(/^0x/);
        });

        test("generates fresh mnemonics when none are supplied", async () => {
            const a = await createTestSession({ appId: "a", storageDir });
            const b = await createTestSession({ appId: "b", storageDir });
            expect(a.localMnemonic).not.toBe(b.localMnemonic);
            expect(a.remoteMnemonic).not.toBe(b.remoteMnemonic);
            expect(a.sessionId).not.toBe(b.sessionId);
        });

        test("respects an explicit sessionId", async () => {
            const result = await createTestSession({
                appId: "my-app",
                storageDir,
                sessionId: "pinned-id",
            });
            expect(result.sessionId).toBe("pinned-id");
            await expect(
                readFile(join(storageDir, "my-app_UserSecrets_pinned-id.json"), "utf-8"),
            ).resolves.toMatch(/^0x/);
        });

        test("respects a custom localDerivation", async () => {
            const result = await createTestSession({
                appId: "my-app",
                storageDir,
                localMnemonic: LOCAL_MNEMONIC,
                remoteMnemonic: REMOTE_MNEMONIC,
                localDerivation: "//custom//path",
            });
            expect(result.localDerivation).toBe("//custom//path");
            const expected = deriveSr25519PublicKey(
                createSr25519Secret(mnemonicToEntropy(LOCAL_MNEMONIC), "//custom//path"),
            );
            expect(result.localAccountId).toEqual(expected);
        });

        test("repeated calls replace the session list", async () => {
            // Documented behavior — second call leaves only the second session
            // on disk. Callers who want multiple sessions should use separate
            // storage dirs.
            const first = await createTestSession({
                appId: "my-app",
                storageDir,
                sessionId: "first",
            });
            const second = await createTestSession({
                appId: "my-app",
                storageDir,
                sessionId: "second",
            });

            const hex = await readFile(join(storageDir, "my-app_SsoSessions.json"), "utf-8");
            const decoded = sessionsCodec.dec(fromHex(hex));
            expect(decoded).toHaveLength(1);
            expect(decoded[0].id).toBe("second");
            // The first session's UserSecrets file is left behind (not cleaned).
            // This matches a real logout flow as well, so we don't try to hide it.
            await expect(
                readFile(join(storageDir, `my-app_UserSecrets_${first.sessionId}.json`), "utf-8"),
            ).resolves.toMatch(/^0x/);
            await expect(
                readFile(join(storageDir, `my-app_UserSecrets_${second.sessionId}.json`), "utf-8"),
            ).resolves.toMatch(/^0x/);
        });

        test("AccountIdCodec is Bytes(32) — keep this invariant if upstream changes", () => {
            // Guards against silent upstream changes to the session-account
            // codec shape that would make our synthesized files unreadable.
            const encoded = AccountIdCodec.enc(createAccountId(new Uint8Array(32).fill(7)));
            expect(encoded).toHaveLength(32);
        });
    });
}
