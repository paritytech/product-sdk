// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical sr25519 product-account public-key derivation.
 *
 * Mirrored byte-for-byte by polkadot-desktop
 * (`polkadot-desktop/src/domains/product/account/service.ts`) and conceptually
 * by polkadot-app-android-v2
 * (`feature/products/impl/.../ProductAccountDerivationUseCase.kt`).
 *
 * The function works on the parent *public* key alone: sr25519 soft derivation
 * is composable on public keys, so the CLI / web host / any external client can
 * compute the same derived address that the mobile wallet derives privately,
 * without ever seeing the secret key.
 *
 * Junction path: ["product", productId, String(derivationIndex)], applied
 * left-to-right. For each junction, a 32-byte chain code is built:
 *   - numeric ("^\d+$") -> SCALE u64 (BigInt), zero-padded to 32 bytes
 *   - string             -> SCALE str (compact-length + UTF-8), zero-padded
 *   - if encoded > 32 bytes -> blake2b256(encoded) (32-byte BLAKE2b digest)
 *
 * # productId constraint (cross-platform parity)
 *
 * `productId` MUST contain at least one non-hex character or be of odd
 * length when serialized as a string. polkadot-app-android-v2's
 * SubstrateJunctionDecoder tries to interpret a junction as hex BEFORE
 * falling through to SCALE-string encoding; polkadot-desktop and this
 * implementation skip that hex branch. For productIds that happen to be
 * even-length all-hex strings (e.g. "deadbeef", "c0ffee01"), Android would
 * derive a different public key than desktop or this implementation. In
 * practice, productIds are always dotNS names (e.g. "playground.dot"),
 * which contain "." and therefore never trip the hex branch on Android.
 */

import { blake2b256 } from "@parity/product-sdk-crypto";
import { HDKD } from "@scure/sr25519";
import { str, u64 } from "scale-ts";

const JUNCTION_ID_LEN = 32;
const NON_NEGATIVE_INTEGER = /^\d+$/;

export function createChainCode(code: string): Uint8Array {
    const encoded = NON_NEGATIVE_INTEGER.test(code) ? u64.enc(BigInt(code)) : str.enc(code);

    if (encoded.length > JUNCTION_ID_LEN) {
        return blake2b256(encoded);
    }

    const chainCode = new Uint8Array(JUNCTION_ID_LEN);
    chainCode.set(encoded);
    return chainCode;
}

export function deriveProductAccountPublicKey(
    parentPublicKey: Uint8Array,
    productId: string,
    derivationIndex: number,
): Uint8Array {
    const junctions = ["product", productId, String(derivationIndex)];
    return junctions.reduce<Uint8Array>(
        (pubkey, junction) => HDKD.publicSoft(pubkey, createChainCode(junction)),
        parentPublicKey,
    );
}
