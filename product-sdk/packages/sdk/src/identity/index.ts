// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk/identity
 *
 * Identity utilities: DotNS name resolution, context-alias derivation,
 * and Ring VRF anonymous aliases.
 */

// DotNS utilities (pure helpers + People-chain username path)
export {
    isValidDotNsName,
    isResolvableDotNsName,
    normalizeDotNsName,
    accountIdHexToBytes,
    resolvePeopleUsernameOwner,
} from "./dotns.js";
export type { PeopleUsernameChain, PeopleUsernameQueryApi } from "./dotns.js";

// DotNS registry reads + writes (Revive contract)
export {
    resolveDotNs,
    reverseDotNs,
    isDotNsAvailable,
    setDotNsRecord,
    prepareDotNsRegistration,
} from "./dotns-registry.js";
export type {
    DotNsClientOptions,
    RegisterDotNsArgs,
    SetRecordArgs,
    DotNsRegistration,
} from "./dotns-registry.js";
export { DotNsError } from "./dotns-errors.js";
export type { DotNsErrorReason } from "./dotns-errors.js";
export { namehash, DOT_NODE } from "./dotns-namehash.js";
export { POP_STATUS, PASEO_ASSETHUB_DOTNS } from "./dotns-abis.js";

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
