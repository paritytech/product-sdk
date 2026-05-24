/**
 * Identity module types
 *
 * Types for DotNS name resolution and context-alias derivation
 */

/** DotNS name resolution result */
export interface DotNsRecord {
    /** Resolved SS58 address */
    address: string;
    /** Name that was resolved */
    name: string;
    /** Owner address */
    owner: string;
    /** Expiration timestamp (if applicable) */
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
