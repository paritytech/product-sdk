// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DEV_PHRASE } from "@polkadot-labs/hdkd-helpers";
import { seedToAccount } from "@parity/product-sdk-keys";
import type { PolkadotSigner } from "polkadot-api";

import type { DevAccountName } from "./types.js";

/**
 * Create a PolkadotSigner for a standard Substrate dev account.
 *
 * Dev accounts use the well-known Substrate dev mnemonic (`DEV_PHRASE`) with
 * Sr25519 key derivation at the path `//{Name}`. These accounts have known
 * private keys and are pre-funded on dev/test chains.
 *
 * Only for local development, scripts, and testing. Never use in production.
 *
 * @param name - Dev account name ("Alice", "Bob", "Charlie", "Dave", "Eve", or "Ferdie").
 * @returns A PolkadotSigner that can sign transactions.
 *
 * @example
 * ```ts
 * import { createDevSigner } from "@parity/product-sdk-tx";
 *
 * const alice = createDevSigner("Alice");
 * const result = await submitAndWatch(tx, alice);
 * ```
 */
export function createDevSigner(name: DevAccountName): PolkadotSigner {
    return seedToAccount(DEV_PHRASE, `//${name}`).signer;
}

/**
 * Get the public key bytes for a dev account.
 *
 * Useful for address derivation or identity checks in tests without
 * needing the full signer.
 *
 * @param name - Dev account name.
 * @returns 32-byte Sr25519 public key.
 */
export function getDevPublicKey(name: DevAccountName): Uint8Array {
    return seedToAccount(DEV_PHRASE, `//${name}`).publicKey;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    // Alice's well-known sr25519 public key
    const ALICE_PUBKEY = new Uint8Array([
        0xd4, 0x35, 0x93, 0xc7, 0x15, 0xfd, 0xd3, 0x1c, 0x61, 0x14, 0x1a, 0xbd, 0x04, 0xa9, 0x9f,
        0xd6, 0x82, 0x2c, 0x85, 0x58, 0x85, 0x4c, 0xcd, 0xe3, 0x9a, 0x56, 0x84, 0xe7, 0xa5, 0x6d,
        0xa2, 0x7d,
    ]);

    describe("createDevSigner", () => {
        test("creates a signer for Alice with known public key", () => {
            const signer = createDevSigner("Alice");
            expect(signer).toBeDefined();
            expect(signer.publicKey).toEqual(ALICE_PUBKEY);
        });

        test("different names produce different signers", () => {
            const alice = createDevSigner("Alice");
            const bob = createDevSigner("Bob");
            expect(alice.publicKey).not.toEqual(bob.publicKey);
        });

        test("all dev account names produce valid signers", () => {
            const names: DevAccountName[] = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Ferdie"];
            const keys = new Set<string>();

            for (const name of names) {
                const signer = createDevSigner(name);
                expect(signer).toBeDefined();
                expect(signer.publicKey).toBeInstanceOf(Uint8Array);
                expect(signer.publicKey.length).toBe(32);
                // All keys should be unique
                const hex = Array.from(signer.publicKey)
                    .map((b) => b.toString(16).padStart(2, "0"))
                    .join("");
                expect(keys.has(hex)).toBe(false);
                keys.add(hex);
            }
        });
    });

    describe("getDevPublicKey", () => {
        test("returns Alice's known public key", () => {
            expect(getDevPublicKey("Alice")).toEqual(ALICE_PUBKEY);
        });

        test("matches the signer's public key", () => {
            const signer = createDevSigner("Bob");
            const pubkey = getDevPublicKey("Bob");
            expect(pubkey).toEqual(signer.publicKey);
        });
    });
}
