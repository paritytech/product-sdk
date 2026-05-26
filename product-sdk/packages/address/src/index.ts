// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-address — Address handling for accounts that live on both Substrate (SS58) and EVM (H160) chains.
 *
 * Convert between formats, validate, normalize SS58 prefixes, and shorten
 * addresses for display.
 *
 * @packageDocumentation
 */
export {
    isValidSs58,
    ss58Decode,
    ss58Encode,
    normalizeSs58,
    toGenericSs58,
    toPolkadotSs58,
    accountIdFromBytes,
    accountIdBytes,
} from "./ss58.js";

export {
    deriveH160,
    ss58ToH160,
    h160ToSs58,
    toH160,
    isValidH160,
} from "./h160.js";

export { truncateAddress, addressesEqual } from "./display.js";

/**
 * An SS58-encoded Substrate address (e.g. `5GrwvaEF...`). The brand marks strings
 * the SDK has validated, so APIs accepting `SS58String` can skip re-checking.
 * Construct one via {@link normalizeSs58} or {@link ss58Encode}.
 */
export type { SS58String } from "@polkadot-api/substrate-bindings";

/**
 * A `0x`-prefixed hex string (e.g. `0xdeadbeef`). The SDK uses it for raw byte
 * values like public keys and EVM addresses.
 */
export type { HexString } from "@polkadot-api/substrate-bindings";
