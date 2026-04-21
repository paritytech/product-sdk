/**
 * Product account derivation
 *
 * Derives product-scoped accounts from a parent account
 */

import { createLogger } from "@parity/product-sdk-logger";
import { blake2b256 } from "@parity/product-sdk-crypto";
import { ss58Encode, ss58Decode, deriveH160 } from "@parity/product-sdk-address";
import type { ProductAccountInfo, AnonymousAliasInfo, RingLocation } from "./types.js";

const log = createLogger("identity");

/**
 * Derive a product-scoped account from a parent account
 *
 * The product account is deterministically derived using:
 * productPublicKey = hash(parentPublicKey || productName)
 *
 * @param parentAddress - Parent account SS58 address
 * @param productName - Product name for derivation
 * @param ss58Prefix - SS58 prefix (default: 42)
 * @returns Product account info
 *
 * @example
 * ```ts
 * const productAccount = deriveProductAccount(
 *   '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
 *   'my-app'
 * );
 * console.log('Product address:', productAccount.address);
 * ```
 */
export function deriveProductAccount(
    parentAddress: string,
    productName: string,
    ss58Prefix = 42,
): ProductAccountInfo {
    const { publicKey: parentPublicKey } = ss58Decode(parentAddress);

    // Derive product public key: blake2b-256(parentPublicKey || productName)
    const productNameBytes = new TextEncoder().encode(productName);
    const combined = new Uint8Array(parentPublicKey.length + productNameBytes.length);
    combined.set(parentPublicKey, 0);
    combined.set(productNameBytes, parentPublicKey.length);

    const productPublicKey = blake2b256(combined);
    const address = ss58Encode(productPublicKey, ss58Prefix);
    const h160Address = deriveH160(productPublicKey);

    log.debug("Derived product account", {
        parentAddress,
        productName,
        address,
    });

    return {
        address,
        h160Address,
        parentAddress,
        productName,
    };
}

/**
 * Verify that a product account was derived from a parent account
 *
 * @param productAddress - Product account address
 * @param parentAddress - Claimed parent address
 * @param productName - Product name
 * @returns True if derivation is valid
 */
export function verifyProductAccount(
    productAddress: string,
    parentAddress: string,
    productName: string,
): boolean {
    try {
        const derived = deriveProductAccount(parentAddress, productName);
        const { publicKey: productKey } = ss58Decode(productAddress);
        const { publicKey: derivedKey } = ss58Decode(derived.address);

        // Compare public keys
        if (productKey.length !== derivedKey.length) return false;
        for (let i = 0; i < productKey.length; i++) {
            if (productKey[i] !== derivedKey[i]) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Derive an anonymous alias using Ring VRF
 *
 * This creates a context-specific alias that cannot be linked
 * back to the original identity without the ring proof.
 *
 * @param context - Context for alias derivation (e.g., "voting-round-1")
 * @param ringLocation - Ring location for proof generation
 * @returns Anonymous alias info
 */
export function deriveAnonymousAlias(
    context: string,
    ringLocation: RingLocation,
): AnonymousAliasInfo {
    log.debug("Deriving anonymous alias", { context, ringLocation });

    // TODO: Implement Ring VRF alias derivation
    // This requires the Ring VRF implementation from TruAPI
    throw new Error(
        "deriveAnonymousAlias() is not yet implemented. " +
            "This requires container mode with Ring VRF support.",
    );
}

/**
 * Create a Ring VRF proof for a message
 *
 * @param message - Message to prove
 * @param ringLocation - Ring location
 * @returns Proof bytes
 */
export async function createRingProof(
    message: Uint8Array,
    ringLocation: RingLocation,
): Promise<Uint8Array> {
    log.debug("Creating ring proof", { ringLocation });

    // TODO: Implement Ring VRF proof creation via TruAPI
    throw new Error(
        "createRingProof() is not yet implemented. " +
            "This requires container mode with Ring VRF support.",
    );
}

/**
 * Verify a Ring VRF proof
 *
 * @param message - Original message
 * @param proof - Proof bytes
 * @param alias - Expected alias
 * @returns True if proof is valid
 */
export async function verifyRingProof(
    message: Uint8Array,
    proof: Uint8Array,
    alias: string,
): Promise<boolean> {
    log.debug("Verifying ring proof");

    // TODO: Implement Ring VRF proof verification
    throw new Error(
        "verifyRingProof() is not yet implemented. " +
            "This requires container mode with Ring VRF support.",
    );
}
