// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk/identity
 *
 * Identity utilities: DotNS name resolution, plus the deprecated context-alias
 * helpers.
 *
 * For real Ring VRF aliases and proofs, use `SignerManager`'s
 * `getProductAccountAlias` and `createRingVRFProof` from
 * `@parity/product-sdk-signer`.
 */

// DotNS utilities
export {
    isValidDotNsName,
    normalizeDotNsName,
    resolveDotNs,
    reverseDotNs,
    isDotNsAvailable,
    accountIdHexToBytes,
    accountIdToHex,
    resolvePeopleUsernameOwner,
} from "./dotns.js";
export type { PeopleUsernameChain, PeopleUsernameQueryApi } from "./dotns.js";

// Context alias utilities (deprecated)
export { deriveContextAlias, verifyContextAlias } from "./product-account.js";

// Types
export type {
    DotNsRecord,
    ContextAliasInfo,
    VerificationResult,
    OnChainIdentity,
} from "./types.js";
