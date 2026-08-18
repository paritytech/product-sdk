// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Identity module types
 *
 * Types for DotNS name resolution and context-alias derivation
 */

/** DotNS name resolution result */
export interface DotNsRecord {
    /**
     * H160 the name resolves to, `0x` and 20 bytes. Not SS58: DotNS is a set of
     * Revive contracts and both address fields come back as EVM addresses.
     * Convert with `h160ToSs58` from `@parity/product-sdk-address` if a
     * Substrate-shaped address is needed.
     *
     * Absent when the name is registered but has no forward record yet, the
     * state of every name just after registration. An unregistered name is
     * `null` from `resolveDotNs`, not a record.
     */
    address?: `0x${string}`;
    /** Name that was resolved, normalized (lowercase, `.dot` suffix) */
    name: string;
    /** H160 of the node's owner. Not SS58, same as {@link DotNsRecord.address}. */
    owner: `0x${string}`;
    /**
     * Expiration timestamp, if the deployment has one.
     *
     * Always absent today: the Paseo Asset Hub registrar exposes no expiry
     * getter, so nothing populates this.
     */
    expiresAt?: number;
}

/** Context alias info: a deterministic, context-bound alias derived from a parent account */
export interface ContextAliasInfo {
    /** Alias SS58 address */
    address: string;
    /** H160 EVM address */
    h160Address: `0x${string}`;
    /** Parent account address */
    parentAddress: string;
    /** Context string used for derivation */
    context: string;
}

/** Ring VRF alias info */
export interface AnonymousAliasInfo {
    /** Anonymous alias identifier */
    alias: string;
    /** Ring location for proof generation */
    ringLocation: RingLocation;
    /** Context used for alias derivation */
    context: string;
}

/** Ring location for VRF proofs */
export interface RingLocation {
    /** Ring index */
    ringIndex: number;
    /** Member index within ring */
    memberIndex: number;
}

/** Identity verification result */
export interface VerificationResult {
    /** Whether identity is verified */
    verified: boolean;
    /** Verification method used */
    method: "on-chain" | "judgement" | "social";
    /** Verification details */
    details?: Record<string, unknown>;
}

/** On-chain identity info */
export interface OnChainIdentity {
    /** Display name */
    display?: string;
    /** Legal name */
    legal?: string;
    /** Web URL */
    web?: string;
    /** Email */
    email?: string;
    /** Twitter handle */
    twitter?: string;
    /** Riot/Matrix handle */
    riot?: string;
    /** Additional fields */
    additional: Array<[string, string]>;
}
