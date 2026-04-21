// Core BYOD API — zero descriptor overhead
export { createChainClient, destroyAll, getClient, isConnected } from "./clients.js";

// Preset environments — zero-config path with built-in descriptors
export { getChainAPI } from "./presets.js";
export type { Environment, PresetChains } from "./presets.js";

// Types
export type {
    ChainClient,
    ChainClientConfig,
    ChainMeta,
    ChainEntry,
} from "./types.js";

// Re-export from host
export { isInsideContainer, isInsideContainerSync } from "@parity/product-sdk-host";
