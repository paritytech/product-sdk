/**
 * @parity/product-sdk/identity
 *
 * Identity utilities including DotNS name resolution,
 * product account derivation, and Ring VRF anonymous aliases.
 */

// DotNS utilities
export {
    isValidDotNsName,
    normalizeDotNsName,
    resolveDotNs,
    reverseDotNs,
    isDotNsAvailable,
} from "./dotns.js";

// Context alias utilities
export {
    deriveContextAlias,
    verifyContextAlias,
    deriveAnonymousAlias,
    createRingProof,
    verifyRingProof,
} from "./product-account.js";

// Types
export type {
    DotNsRecord,
    ContextAliasInfo,
    AnonymousAliasInfo,
    RingLocation,
    VerificationResult,
    OnChainIdentity,
} from "./types.js";
