// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-chain-client — Typed, multi-chain Polkadot API client.
 *
 * Pick the entry point that fits how much you want to wire up yourself:
 * `getChainAPI` is the zero-config path with built-in descriptors and RPC endpoints
 * (Paseo and Summit are live today; Polkadot and Kusama are reserved but not yet enabled), and
 * `createChainClient` is the bring-your-own-descriptors path for custom or
 * pre-release chains.
 *
 * @packageDocumentation
 */

// Core BYOD API — zero descriptor overhead
export { createChainClient, destroyAll, getClient, isConnected } from "./clients.js";

// Preset environments — zero-config path with built-in descriptors
export { getChainAPI } from "./presets.js";
export type { Environment, PresetChains } from "./presets.js";

// Types
export type { ChainClient, ChainClientConfig, ChainEntry } from "./types.js";

// Well-known chain genesis hashes
export { WellKnownChain } from "./well-known-chain.js";
export type { WellKnownChainHash } from "./well-known-chain.js";

// Re-export from host
export {
    isInsideContainer,
    isInsideContainerSync,
    ChainNotSupportedError,
} from "@parity/product-sdk-host";
