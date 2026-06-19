// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Private mirror of host-papp's `AllowanceRepository` on-disk format.
 *
 * The repository codec + AES-GCM scheme are internal to host-papp — only the
 * higher-level `AllowanceService` is on the public surface, and that service
 * exposes no cache-only probe (its `getBulletinSigner` / `getStatementStoreProver`
 * fall through to `requestResourceAllocation` on cache miss, which prompts the
 * paired wallet). For "is there an allowance slot for this tuple on disk?"
 * answers — needed by login-readiness checks that must not pop a phone
 * dialog — we have to read the storage file ourselves.
 *
 * This module vendors:
 *  - the SCALE codec for the `Vector(StoredAllowanceEntry)` blob host-papp
 *    writes,
 *  - the AES-GCM key + nonce derivation host-papp uses
 *    (`blake2b(appId, 16)` / `blake2b("nonce", 32)`),
 *  - the storage-key naming convention (`AllowanceKeys_<sessionId>`).
 *
 * Drift guards:
 *  - `satisfies Codec<StoredAllowanceEntry>` catches type-shape drift at
 *    build time.
 *  - `allowance.interop.test.ts` round-trips an encoded entry through the
 *    real host-papp `AllowanceService.getBulletinSigner` and asserts the
 *    derived signer's pubkey matches — that catches byte-level drift at
 *    test time.
 *
 * TODO: drop this mirror when host-papp's `AllowanceService` gains a
 * cache-only check (e.g. `hasAllowance(sessionId, productId, resource)`)
 * on its public surface. Until then we have to read the file ourselves.
 *
 * @module
 */
import { gcm } from "@noble/ciphers/aes.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { fromHex, toHex } from "@polkadot-api/utils";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bytes, type Codec, Enum, Struct, Vector, _void, str } from "scale-ts";

import { sanitizeKey } from "./node-storage.js";

/** Resource kinds host-papp allocates slot accounts for. */
export type AllowanceResourceKind = "bulletin" | "statementStore";

/** One entry in the persisted allowance list. */
export type StoredAllowanceEntry = {
    productId: string;
    resource: { tag: AllowanceResourceKind; value: undefined };
    slotAccountKey: Uint8Array;
};

const AllowanceResourceKindCodec = Enum({
    bulletin: _void,
    statementStore: _void,
});

const StoredAllowanceEntryCodec = Struct({
    productId: str,
    resource: AllowanceResourceKindCodec,
    slotAccountKey: Bytes(),
}) satisfies Codec<StoredAllowanceEntry>;

const StoredAllowancesCodec = Vector(StoredAllowanceEntryCodec);

/**
 * AES-GCM key + nonce derivation host-papp uses for both the allowance
 * repository and the user-secrets repository — same salt (appId) seeds both.
 */
function getAes(appId: string) {
    const key = blake2b(new TextEncoder().encode(appId), { dkLen: 16 });
    const nonce = blake2b(new TextEncoder().encode("nonce"), { dkLen: 32 });
    return gcm(key, nonce);
}

/**
 * Storage file path host-papp writes the allowance list to, derived from
 * `appId` and `sessionId` via the same `sanitizeKey` rule the rest of the
 * package uses.
 */
function allowanceFilePath(storageDir: string, appId: string, sessionId: string): string {
    return join(storageDir, `${sanitizeKey(appId, `AllowanceKeys_${sessionId}`)}.json`);
}

/**
 * Read and decrypt the allowance list for a session. Returns `[]` when the
 * file is absent (the steady-state "never paired for this session" case);
 * throws on decrypt or decode failure (a corrupted file is a real failure,
 * not a "no allowance" signal — silently treating it as empty would mask
 * a bug).
 */
export async function readStoredAllowances(
    storageDir: string,
    appId: string,
    sessionId: string,
): Promise<StoredAllowanceEntry[]> {
    let hex: string;
    try {
        hex = await readFile(allowanceFilePath(storageDir, appId, sessionId), "utf-8");
    } catch (err) {
        // ENOENT is the only error we treat as "no entries".
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw err;
    }
    const decrypted = getAes(appId).decrypt(fromHex(hex));
    return StoredAllowancesCodec.dec(decrypted);
}

/**
 * Encode + encrypt + write an allowance list to disk. Used by the interop
 * test to pre-seed a cache entry without having to drive a wallet round-trip.
 * Not exported from the package — internal to `*.interop.test.ts`.
 */
export async function writeStoredAllowances(
    storageDir: string,
    appId: string,
    sessionId: string,
    entries: StoredAllowanceEntry[],
): Promise<void> {
    const encoded = StoredAllowancesCodec.enc(entries);
    const encrypted = toHex(getAes(appId).encrypt(encoded));
    await writeFile(allowanceFilePath(storageDir, appId, sessionId), encrypted, "utf-8");
}
