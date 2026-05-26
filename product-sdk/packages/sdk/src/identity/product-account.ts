// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Context alias derivation
 *
 * Derives a deterministic, context-bound alias from a parent account using blake2b-256.
 *
 * NOTE: this is NOT the canonical sr25519 product-account derivation used by
 * mobile, desktop, and dotli hosts. For that, use
 * `@parity/product-sdk-keys::deriveProductAccountPublicKey`.
 */

import { createLogger } from "@parity/product-sdk-logger";
import { blake2b256 } from "@parity/product-sdk-crypto";
import { ss58Encode, ss58Decode, deriveH160 } from "@parity/product-sdk-address";
import type { ContextAliasInfo, AnonymousAliasInfo, RingLocation } from "./types.js";

const log = createLogger("identity");

/**
 * Derive a context-bound alias from a parent account.
 *
 * The alias is deterministically derived using:
 * aliasPublicKey = blake2b256(parentPublicKey || context)
 *
 * @param parentAddress - Parent account SS58 address
 * @param context - Context string for derivation (e.g. an app id or scope label)
 * @param ss58Prefix - SS58 prefix (default: 42)
 * @returns Context alias info
 *
 * @example
 * ```ts
 * const alias = deriveContextAlias(
 *   '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
 *   'voting-round-1'
 * );
 * console.log('Alias address:', alias.address);
 * ```
 */
export function deriveContextAlias(
    parentAddress: string,
    context: string,
    ss58Prefix = 42,
): ContextAliasInfo {
    const { publicKey: parentPublicKey } = ss58Decode(parentAddress);

    // Derive alias public key: blake2b-256(parentPublicKey || context)
    const contextBytes = new TextEncoder().encode(context);
    const combined = new Uint8Array(parentPublicKey.length + contextBytes.length);
    combined.set(parentPublicKey, 0);
    combined.set(contextBytes, parentPublicKey.length);

    const aliasPublicKey = blake2b256(combined);
    const address = ss58Encode(aliasPublicKey, ss58Prefix);
    const h160Address = deriveH160(aliasPublicKey);

    log.debug("Derived context alias", {
        parentAddress,
        context,
        address,
    });

    return {
        address,
        h160Address,
        parentAddress,
        context,
    };
}

/**
 * Verify that a context alias was derived from a parent account.
 *
 * @param aliasAddress - Context alias SS58 address
 * @param parentAddress - Claimed parent address
 * @param context - Context string used for derivation
 * @returns True if derivation is valid
 */
export function verifyContextAlias(
    aliasAddress: string,
    parentAddress: string,
    context: string,
): boolean {
    try {
        const derived = deriveContextAlias(parentAddress, context);
        const { publicKey: aliasKey } = ss58Decode(aliasAddress);
        const { publicKey: derivedKey } = ss58Decode(derived.address);

        // Compare public keys
        if (aliasKey.length !== derivedKey.length) return false;
        for (let i = 0; i < aliasKey.length; i++) {
            if (aliasKey[i] !== derivedKey[i]) return false;
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
