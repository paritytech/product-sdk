/**
 * @parity/product-sdk-chain-client — Typed, multi-chain Polkadot API client.
 *
 * Pick the entry point that fits how much you want to wire up yourself:
 * `getChainAPI` is the zero-config path with built-in descriptors and RPC endpoints
 * (Paseo is live today; Polkadot and Kusama are reserved but not yet enabled), and
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

// Re-export from host
export { isInsideContainer, isInsideContainerSync } from "@parity/product-sdk-host";
