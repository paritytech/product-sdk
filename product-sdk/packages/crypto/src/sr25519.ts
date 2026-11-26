// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519";

/** An sr25519 key pair: the 32-byte public key and the 64-byte secret key. */
export interface Sr25519Keypair {
    /** 32-byte public key. */
    publicKey: Uint8Array;
    /**
     * 64-byte secret key: the scalar followed by the nonce, in the
     * Ed25519-expanded encoding Polkadot hosts accept wherever they take an
     * sr25519 secret (such as a payment top-up's `PrivateKey` source).
     */
    secretKey: Uint8Array;
}

/**
 * Expand a 32-byte seed into an sr25519 key pair, the way Substrate expands a
 * mini secret key (schnorrkel's Ed25519 expansion mode).
 *
 * Use it for a seed the product already holds, such as host entropy. A
 * mnemonic and derivation path go through `seedToAccount` in
 * `@parity/product-sdk-keys` instead.
 *
 * @param seed - 32 bytes.
 * @returns The public key and the 64-byte secret key.
 * @throws RangeError when the seed is not 32 bytes.
 *
 * @example
 * ```ts
 * import { sr25519KeypairFromSeed } from "@parity/product-sdk-crypto";
 *
 * const { publicKey, secretKey } = sr25519KeypairFromSeed(seed);
 * ```
 */
export function sr25519KeypairFromSeed(seed: Uint8Array): Sr25519Keypair {
    if (seed.length !== 32) {
        throw new RangeError(`sr25519 seed must be 32 bytes, got ${seed.length}`);
    }
    const secretKey = secretFromSeed(seed);
    return { publicKey: getPublicKey(secretKey), secretKey };
}

/**
 * Sign `message` with a 64-byte sr25519 secret key from
 * {@link sr25519KeypairFromSeed}. Signatures are randomized, so two calls
 * differ; both verify.
 *
 * @returns The 64-byte signature.
 */
export function sr25519Sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
    return sign(secretKey, message);
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;
    const { verify } = await import("@scure/sr25519");
    const { hexToBytes, bytesToHex } = await import("@noble/hashes/utils.js");

    describe("sr25519KeypairFromSeed", () => {
        // Substrate's development phrase ("bottom drive obey lake …"): its mini
        // secret and the public key every Substrate tool derives from it.
        const DEV_SEED = "fac7959dbfe72f052e5a0c3c8d6530f202b02fd8f9f5ca3580ec8deb7797479e";
        const DEV_PUBLIC = "46ebddef8cd9bb167dc30878d7113b7e168e6f0646beffd77d69d39bad76b47a";

        test("matches Substrate's expansion of the development seed", () => {
            const { publicKey, secretKey } = sr25519KeypairFromSeed(hexToBytes(DEV_SEED));
            expect(bytesToHex(publicKey)).toBe(DEV_PUBLIC);
            expect(secretKey).toHaveLength(64);
        });

        // Checked against schnorrkel 0.11.5: the core's sr25519 parser reads this
        // secret through its Ed25519-bytes path to the same key schnorrkel's
        // `expand_to_keypair(ExpansionMode::Ed25519)` gives for the seed.
        test("pins the secret a Polkadot host parses back to the same key", () => {
            const { publicKey, secretKey } = sr25519KeypairFromSeed(new Uint8Array(32).fill(7));
            expect(bytesToHex(secretKey)).toBe(
                "28ad39fefd7fa3e200a9c626eef599e61a2d055c48a8288a4e7e4c4bca392878" +
                    "9c7d6db3506d65dbac7c052aaee4857425210c9bc54030c826e54055983452a5",
            );
            expect(bytesToHex(publicKey)).toBe(
                "7c0f469d3bd340bae718203fa30ca071a5e37c751e891dbded837b213d45d91d",
            );
        });

        test("is deterministic", () => {
            const seed = new Uint8Array(32).fill(7);
            expect(sr25519KeypairFromSeed(seed)).toEqual(sr25519KeypairFromSeed(seed));
        });

        test("refuses a seed that is not 32 bytes", () => {
            expect(() => sr25519KeypairFromSeed(new Uint8Array(31))).toThrow(RangeError);
        });

        test("signs messages the public key verifies", () => {
            const { publicKey, secretKey } = sr25519KeypairFromSeed(new Uint8Array(32).fill(1));
            const message = new TextEncoder().encode("hello");
            expect(verify(message, sr25519Sign(secretKey, message), publicKey)).toBe(true);
        });
    });
}
