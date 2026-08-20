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

// DotNS utilities (pure helpers + People-chain username path)
export {
    isValidDotNsName,
    isResolvableDotNsName,
    normalizeDotNsName,
    accountIdHexToBytes,
    accountIdToHex,
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
export {
    namehash,
    dotNsTld,
    isConsistentDotNsTld,
    stripSuffix,
    DOT_NODE,
    DOT_TLD,
} from "./dotns-namehash.js";
export type { DotNsTld } from "./dotns-namehash.js";
export { POP_STATUS, DOTNS_ADDRESSES } from "./dotns-abis.js";

// Context alias utilities (deprecated)
export { deriveContextAlias, verifyContextAlias } from "./product-account.js";

// Types
export type {
    DotNsRecord,
    ContextAliasInfo,
    VerificationResult,
    OnChainIdentity,
} from "./types.js";
