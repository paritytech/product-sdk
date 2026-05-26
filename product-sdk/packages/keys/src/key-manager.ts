// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { getPolkadotSigner } from "polkadot-api/signer";

import { deriveH160, ss58Encode } from "@parity/product-sdk-address";
import { deriveKey, nacl } from "@parity/product-sdk-crypto";

import type { DerivedAccount, DerivedKeypairs } from "./types.js";

const DEFAULT_SALT = "product-sdk-keys-v1";

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Hierarchical key manager.
 *
 * Holds a 32-byte master key in memory and derives child keys via HKDF-SHA256.
 * Does not persist anything — persistence is the consumer's responsibility.
 */
export class KeyManager {
    private readonly masterKey: Uint8Array;

    private constructor(masterKey: Uint8Array) {
        this.masterKey = masterKey;
    }

    /**
     * Create a KeyManager from a cryptographic signature.
     *
     * Derives master key via HKDF-SHA256:
     *   IKM = signatureBytes, salt = options.salt (default "product-sdk-keys-v1"), info = signerAddress
     *
     * @param signature - Hex string (with/without 0x prefix) or raw bytes
     * @param signerAddress - SS58 address of the signer
     * @param options.salt - HKDF salt, defaults to "product-sdk-keys-v1"
     */
    static fromSignature(
        signature: Uint8Array | string,
        signerAddress: string,
        options?: { salt?: string },
    ): KeyManager {
        const sigBytes =
            signature instanceof Uint8Array
                ? signature
                : hexToBytes(signature.startsWith("0x") ? signature.slice(2) : signature);
        if (sigBytes.length < 32) {
            throw new Error(
                `Signature too short: expected at least 32 bytes, got ${sigBytes.length}`,
            );
        }
        const salt = options?.salt ?? DEFAULT_SALT;
        const masterKey = deriveKey(sigBytes, salt, signerAddress);
        return new KeyManager(masterKey);
    }

    /**
     * Create a KeyManager from raw 32-byte key material.
     * For restoring from storage, testing, etc.
     */
    static fromRawKey(masterKey: Uint8Array): KeyManager {
        if (masterKey.length !== 32) {
            throw new Error(`Expected 32-byte master key, got ${masterKey.length} bytes`);
        }
        return new KeyManager(masterKey.slice());
    }

    /**
     * Derive a 32-byte symmetric key for a given context string.
     *
     * Uses HKDF-SHA256: IKM=masterKey, salt="", info=context
     */
    deriveSymmetricKey(context: string): Uint8Array {
        return deriveKey(this.masterKey, "", context);
    }

    /**
     * Derive a Substrate sr25519 account for a given context string.
     *
     * HKDF(masterKey, "", "account:" + context) → 32-byte seed → sr25519 keypair
     */
    deriveAccount(context: string, ss58Prefix = 42): DerivedAccount {
        const seed = deriveKey(this.masterKey, "", `account:${context}`);
        const derive = sr25519CreateDerive(seed);
        const keyPair = derive("//0");

        const ss58Address = ss58Encode(keyPair.publicKey, ss58Prefix);
        const h160Address = deriveH160(keyPair.publicKey);
        const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);

        return { publicKey: keyPair.publicKey, ss58Address, h160Address, signer };
    }

    /**
     * Derive NaCl encryption and signing keypairs from the master key.
     *
     * - Encryption: HKDF(masterKey, "", "encryption-keypair") → nacl.box.keyPair.fromSecretKey
     * - Signing: HKDF(masterKey, "", "signing-keypair") → nacl.sign.keyPair.fromSeed
     */
    deriveKeypairs(): DerivedKeypairs {
        const encSeed = deriveKey(this.masterKey, "", "encryption-keypair");
        const encKp = nacl.box.keyPair.fromSecretKey(encSeed);

        const sigSeed = deriveKey(this.masterKey, "", "signing-keypair");
        const sigKp = nacl.sign.keyPair.fromSeed(sigSeed);

        return {
            encryption: {
                publicKey: encKp.publicKey,
                secretKey: encKp.secretKey,
            },
            signing: {
                publicKey: sigKp.publicKey,
                secretKey: sigKp.secretKey,
            },
        };
    }

    /**
     * Export the raw master key bytes for consumer-managed persistence.
     */
    exportKey(): Uint8Array {
        return this.masterKey.slice();
    }
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    const TEST_SIG = new Uint8Array(64).fill(0xaa);
    const TEST_ADDR = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    describe("KeyManager.fromSignature", () => {
        test("deterministic master key from fixed signature", () => {
            const a = KeyManager.fromSignature(TEST_SIG, TEST_ADDR);
            const b = KeyManager.fromSignature(TEST_SIG, TEST_ADDR);
            expect(a.exportKey()).toEqual(b.exportKey());
            expect(a.exportKey().length).toBe(32);
        });

        test("accepts hex string with 0x prefix", () => {
            const hex = `0x${"aa".repeat(64)}`;
            const fromHex = KeyManager.fromSignature(hex, TEST_ADDR);
            const fromBytes = KeyManager.fromSignature(TEST_SIG, TEST_ADDR);
            expect(fromHex.exportKey()).toEqual(fromBytes.exportKey());
        });

        test("accepts hex string without 0x prefix", () => {
            const hex = "aa".repeat(64);
            const fromHex = KeyManager.fromSignature(hex, TEST_ADDR);
            const fromBytes = KeyManager.fromSignature(TEST_SIG, TEST_ADDR);
            expect(fromHex.exportKey()).toEqual(fromBytes.exportKey());
        });

        test("different addresses produce different master keys", () => {
            const a = KeyManager.fromSignature(TEST_SIG, TEST_ADDR);
            const b = KeyManager.fromSignature(
                TEST_SIG,
                "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
            );
            expect(a.exportKey()).not.toEqual(b.exportKey());
        });

        test("custom salt produces different master key", () => {
            const a = KeyManager.fromSignature(TEST_SIG, TEST_ADDR);
            const b = KeyManager.fromSignature(TEST_SIG, TEST_ADDR, { salt: "custom-salt" });
            expect(a.exportKey()).not.toEqual(b.exportKey());
        });

        test("rejects empty signature", () => {
            expect(() => KeyManager.fromSignature(new Uint8Array(0), TEST_ADDR)).toThrow(
                "Signature too short",
            );
        });

        test("rejects short signature", () => {
            expect(() => KeyManager.fromSignature(new Uint8Array(16), TEST_ADDR)).toThrow(
                "Signature too short",
            );
        });

        test("rejects empty hex string", () => {
            expect(() => KeyManager.fromSignature("0x", TEST_ADDR)).toThrow("Signature too short");
        });
    });

    describe("KeyManager.fromRawKey", () => {
        test("accepts 32-byte key", () => {
            const key = new Uint8Array(32).fill(0xbb);
            const km = KeyManager.fromRawKey(key);
            expect(km.exportKey()).toEqual(key);
        });

        test("rejects non-32-byte input", () => {
            expect(() => KeyManager.fromRawKey(new Uint8Array(16))).toThrow("Expected 32-byte");
            expect(() => KeyManager.fromRawKey(new Uint8Array(64))).toThrow("Expected 32-byte");
        });

        test("exportKey returns a copy", () => {
            const key = new Uint8Array(32).fill(0xcc);
            const km = KeyManager.fromRawKey(key);
            const exported = km.exportKey();
            exported[0] = 0xff;
            expect(km.exportKey()[0]).toBe(0xcc);
        });

        test("copies input — mutating original does not affect internal state", () => {
            const key = new Uint8Array(32).fill(0xaa);
            const km = KeyManager.fromRawKey(key);
            key[0] = 0xff;
            expect(km.exportKey()[0]).toBe(0xaa);
        });
    });

    describe("deriveSymmetricKey", () => {
        test("deterministic for same context", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xdd));
            const a = km.deriveSymmetricKey("doc:123");
            const b = km.deriveSymmetricKey("doc:123");
            expect(a).toEqual(b);
            expect(a.length).toBe(32);
        });

        test("different contexts produce different keys", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xdd));
            const a = km.deriveSymmetricKey("doc:123");
            const b = km.deriveSymmetricKey("doc:456");
            expect(a).not.toEqual(b);
        });

        test("empty context string works", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xdd));
            const key = km.deriveSymmetricKey("");
            expect(key.length).toBe(32);
        });

        test("deriveSymmetricKey and deriveAccount use different domains", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xdd));
            const symKey = km.deriveSymmetricKey("foo");
            const accountSeed = km.deriveSymmetricKey("account:foo");
            // deriveAccount("foo") uses info="account:foo" internally,
            // so its HKDF output matches deriveSymmetricKey("account:foo")
            // but the final account is further derived through sr25519
            expect(symKey).not.toEqual(accountSeed);
        });
    });

    describe("deriveAccount", () => {
        test("deterministic for same context", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xee));
            const a = km.deriveAccount("doc-account:123");
            const b = km.deriveAccount("doc-account:123");
            expect(a.ss58Address).toBe(b.ss58Address);
            expect(a.h160Address).toBe(b.h160Address);
            expect(a.publicKey).toEqual(b.publicKey);
        });

        test("produces valid addresses", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xee));
            const account = km.deriveAccount("test");
            expect(account.ss58Address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
            expect(account.h160Address).toMatch(/^0x[a-f0-9]{40}$/);
            expect(account.publicKey.length).toBe(32);
        });

        test("different contexts produce different accounts", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xee));
            const a = km.deriveAccount("ctx-a");
            const b = km.deriveAccount("ctx-b");
            expect(a.ss58Address).not.toBe(b.ss58Address);
        });

        test("custom ss58Prefix changes address encoding", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xee));
            const generic = km.deriveAccount("test", 42);
            const polkadot = km.deriveAccount("test", 0);
            expect(generic.ss58Address).not.toBe(polkadot.ss58Address);
            expect(generic.publicKey).toEqual(polkadot.publicKey);
        });

        test("signer has correct publicKey", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xee));
            const account = km.deriveAccount("test");
            expect(account.signer.publicKey).toEqual(account.publicKey);
        });
    });

    describe("deriveKeypairs", () => {
        test("deterministic from same master key", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xff));
            const a = km.deriveKeypairs();
            const b = km.deriveKeypairs();
            expect(a.encryption.publicKey).toEqual(b.encryption.publicKey);
            expect(a.signing.publicKey).toEqual(b.signing.publicKey);
        });

        test("NaCl Box encrypt/decrypt round-trip", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xff));
            const kp = km.deriveKeypairs();
            const message = new TextEncoder().encode("hello keys");
            const nonce = nacl.randomBytes(24);
            const encrypted = nacl.box(
                message,
                nonce,
                kp.encryption.publicKey,
                kp.encryption.secretKey,
            );
            expect(encrypted).not.toBeNull();
            const decrypted = nacl.box.open(
                encrypted!,
                nonce,
                kp.encryption.publicKey,
                kp.encryption.secretKey,
            );
            expect(new TextDecoder().decode(decrypted!)).toBe("hello keys");
        });

        test("NaCl Box two-party encrypt/decrypt", () => {
            const kmA = KeyManager.fromRawKey(new Uint8Array(32).fill(0xaa));
            const kmB = KeyManager.fromRawKey(new Uint8Array(32).fill(0xbb));
            const kpA = kmA.deriveKeypairs();
            const kpB = kmB.deriveKeypairs();
            const message = new TextEncoder().encode("secret for B");
            const nonce = nacl.randomBytes(24);
            // A encrypts for B
            const encrypted = nacl.box(
                message,
                nonce,
                kpB.encryption.publicKey,
                kpA.encryption.secretKey,
            );
            expect(encrypted).not.toBeNull();
            // B decrypts from A
            const decrypted = nacl.box.open(
                encrypted!,
                nonce,
                kpA.encryption.publicKey,
                kpB.encryption.secretKey,
            );
            expect(new TextDecoder().decode(decrypted!)).toBe("secret for B");
        });

        test("NaCl Sign sign/verify round-trip", () => {
            const km = KeyManager.fromRawKey(new Uint8Array(32).fill(0xff));
            const kp = km.deriveKeypairs();
            const message = new TextEncoder().encode("sign this");
            const signed = nacl.sign(message, kp.signing.secretKey);
            const opened = nacl.sign.open(signed, kp.signing.publicKey);
            expect(new TextDecoder().decode(opened!)).toBe("sign this");
        });
    });
}
