// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk/identity
 *
 * Identity utilities: DotNS name resolution, context-alias derivation,
 * and Ring VRF anonymous aliases.
 */

// DotNS utilities
export {
    isValidDotNsName,
    normalizeDotNsName,
    resolveDotNs,
    reverseDotNs,
    isDotNsAvailable,
    accountIdHexToBytes,
    resolvePeopleUsernameOwner,
} from "./dotns.js";
export type { PeopleUsernameChain, PeopleUsernameQueryApi } from "./dotns.js";

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
