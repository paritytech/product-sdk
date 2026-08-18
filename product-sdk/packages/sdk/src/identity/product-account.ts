// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Context alias derivation (deprecated, removal in 0.23.0)
 *
 * Derives a deterministic, context-bound alias from a parent account using blake2b-256.
 *
 * The output is a hash, not a key, so no signing key exists for the addresses
 * returned here. See the notes on each function for what to use instead.
 *
 * NOTE: this is NOT the canonical sr25519 product-account derivation used by
 * mobile, desktop, and dotli hosts. For that, use
 * `@parity/product-sdk-keys::deriveProductAccountPublicKey`.
 */

import { createLogger } from "@parity/product-sdk-logger";
import { blake2b256 } from "@parity/product-sdk-crypto";
import { ss58Encode, ss58Decode, deriveH160 } from "@parity/product-sdk-address";
import type { ContextAliasInfo } from "./types.js";

const log = createLogger("identity");

/**
 * Derive a context-bound alias from a parent account.
 *
 * The alias is deterministically derived using:
 * aliasPublicKey = blake2b256(parentPublicKey || context)
 *
 * @deprecated Returns addresses that no key can spend. The alias public key is a
 *   blake2b-256 hash rather than a derived key, so no secret corresponds to the
 *   SS58 address or to the H160: both can receive value and neither can ever
 *   send it. Removal: `@parity/product-sdk` 0.23.0. Replace by intent:
 *
 *   - An account that holds or spends value:
 *     `SignerManager.getProductAccount(dotNsIdentifier, index)` from
 *     `@parity/product-sdk-signer`. Host-backed and actually signable.
 *   - The address offline, with no host: `deriveProductAccountPublicKey` from
 *     `@parity/product-sdk-keys`, the canonical sr25519 soft derivation.
 *   - An unlinkable per-context alias: select a registered ring-VRF key, then call
 *     `SignerManager.getProductAccountAlias(keyHandle, context, location)` or
 *     `createRingVRFProof(keyHandle, context, location, message)`.
 *   - A context-scoped identifier, never used as an account: `blake2b256` from
 *     `@parity/product-sdk/crypto`. Same bytes, without address packaging that
 *     invites the mistake.
 *
 * @param parentAddress - Parent account SS58 address
 * @param context - Context string for derivation (e.g. an app id or scope label)
 * @param ss58Prefix - SS58 prefix (default: 42)
 * @returns Context alias info
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
 * @deprecated Recomputes {@link deriveContextAlias} from two public values and
 *   compares the result, so it confirms a derivation relationship and nothing
 *   more. No secret enters the operation at any point, which means there is
 *   nothing here to authenticate: a passing result does not show that anyone
 *   controls either account. Removal: `@parity/product-sdk` 0.23.0.
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
