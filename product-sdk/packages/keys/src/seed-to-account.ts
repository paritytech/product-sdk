// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { ed25519CreateDerive, sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";

import { deriveH160, ss58Encode } from "@parity/product-sdk-address";

import type { DerivedAccount } from "./types.js";

/**
 * Derive a DerivedAccount from a BIP39 mnemonic phrase.
 *
 * Uses the specified key type for derivation with a hard derivation path
 * (default `"//0"`).
 *
 * @param mnemonic - BIP39 mnemonic phrase
 * @param derivationPath - Hard derivation path, defaults to `"//0"`
 * @param ss58Prefix - SS58 network prefix, defaults to 42 (generic)
 * @param keyType - Key type for derivation, either `"sr25519"` or `"ed25519"`, defaults to `"sr25519"`
 */
export function seedToAccount(
    mnemonic: string,
    derivationPath = "//0",
    ss58Prefix = 42,
    keyType: "sr25519" | "ed25519" = "sr25519",
): DerivedAccount {
    let entropy: Uint8Array;
    try {
        entropy = mnemonicToEntropy(mnemonic);
    } catch (cause) {
        throw new Error("Invalid mnemonic phrase", { cause });
    }
    const miniSecret = entropyToMiniSecret(entropy);
    const derive =
        keyType === "ed25519" ? ed25519CreateDerive(miniSecret) : sr25519CreateDerive(miniSecret);
    const keyPair = derive(derivationPath);

    const signerKeyType = keyType === "ed25519" ? "Ed25519" : "Sr25519";
    const ss58Address = ss58Encode(keyPair.publicKey, ss58Prefix);
    const h160Address = deriveH160(keyPair.publicKey);
    const signer = getPolkadotSigner(keyPair.publicKey, signerKeyType, keyPair.sign);

    return {
        publicKey: keyPair.publicKey,
        ss58Address,
        h160Address,
        signer,
    };
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;
    const { generateMnemonic } = await import("@polkadot-labs/hdkd-helpers");

    // Fixed test mnemonic (DO NOT use in production)
    const TEST_MNEMONIC =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    describe("seedToAccount", () => {
        test("deterministic derivation from fixed mnemonic", () => {
            const a = seedToAccount(TEST_MNEMONIC);
            const b = seedToAccount(TEST_MNEMONIC);
            expect(a.ss58Address).toBe(b.ss58Address);
            expect(a.h160Address).toBe(b.h160Address);
            expect(a.publicKey).toEqual(b.publicKey);
            expect(a.publicKey.length).toBe(32);
        });

        test("returns valid SS58 and H160 addresses", () => {
            const account = seedToAccount(TEST_MNEMONIC);
            expect(account.ss58Address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
            expect(account.h160Address).toMatch(/^0x[a-f0-9]{40}$/);
        });

        test("custom derivation path produces different addresses", () => {
            const a = seedToAccount(TEST_MNEMONIC, "//0");
            const b = seedToAccount(TEST_MNEMONIC, "//1");
            expect(a.ss58Address).not.toBe(b.ss58Address);
            expect(a.h160Address).not.toBe(b.h160Address);
        });

        test("custom SS58 prefix changes address encoding", () => {
            const generic = seedToAccount(TEST_MNEMONIC, "//0", 42);
            const polkadot = seedToAccount(TEST_MNEMONIC, "//0", 0);
            expect(generic.ss58Address).not.toBe(polkadot.ss58Address);
            // Same underlying public key
            expect(generic.publicKey).toEqual(polkadot.publicKey);
            expect(generic.h160Address).toBe(polkadot.h160Address);
        });

        test("provides a signer", () => {
            const account = seedToAccount(TEST_MNEMONIC);
            expect(account.signer).toBeDefined();
            expect(account.signer.publicKey).toEqual(account.publicKey);
        });

        test("works with a freshly generated mnemonic", () => {
            const mnemonic = generateMnemonic();
            const account = seedToAccount(mnemonic);
            expect(account.ss58Address).toBeTruthy();
            expect(account.publicKey.length).toBe(32);
        });

        test("throws descriptive error for invalid mnemonic", () => {
            expect(() => seedToAccount("not a valid mnemonic")).toThrow("Invalid mnemonic phrase");
        });

        test("throws descriptive error for empty string", () => {
            expect(() => seedToAccount("")).toThrow("Invalid mnemonic phrase");
        });

        test("ed25519 derivation produces different address than sr25519", () => {
            const sr = seedToAccount(TEST_MNEMONIC, "//0", 42, "sr25519");
            const ed = seedToAccount(TEST_MNEMONIC, "//0", 42, "ed25519");
            expect(ed.ss58Address).not.toBe(sr.ss58Address);
            expect(ed.publicKey).not.toEqual(sr.publicKey);
        });

        test("ed25519 derivation is deterministic", () => {
            const a = seedToAccount(TEST_MNEMONIC, "//0", 42, "ed25519");
            const b = seedToAccount(TEST_MNEMONIC, "//0", 42, "ed25519");
            expect(a.ss58Address).toBe(b.ss58Address);
            expect(a.h160Address).toBe(b.h160Address);
            expect(a.publicKey).toEqual(b.publicKey);
            expect(a.publicKey.length).toBe(32);
        });

        test("ed25519 provides a signer with matching publicKey", () => {
            const account = seedToAccount(TEST_MNEMONIC, "//0", 42, "ed25519");
            expect(account.signer).toBeDefined();
            expect(account.signer.publicKey).toEqual(account.publicKey);
        });

        test("default keyType is sr25519 (backward compatible)", () => {
            const withDefault = seedToAccount(TEST_MNEMONIC);
            const withExplicit = seedToAccount(TEST_MNEMONIC, "//0", 42, "sr25519");
            expect(withDefault.ss58Address).toBe(withExplicit.ss58Address);
            expect(withDefault.publicKey).toEqual(withExplicit.publicKey);
        });
    });
}
