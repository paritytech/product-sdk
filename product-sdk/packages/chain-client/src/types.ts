import type { ChainDefinition, PolkadotClient, TypedApi } from "polkadot-api";

/** Supported chain environments for the Polkadot ecosystem. */
export type Environment = "polkadot" | "kusama" | "paseo" | "local" | "westend";

/**
 * Connection metadata for a chain.
 *
 * Note: The SDK is designed to run inside a host container. The `rpcs` field
 * is kept for compatibility but connections are routed through the host provider.
 */
export interface ChainMeta {
    /** RPC endpoints (used as hint for host provider). */
    rpcs?: readonly string[];
}

/**
 * Configuration for {@link createChainClient}.
 *
 * Provide named chain descriptors and their RPC endpoints.
 * TypeScript enforces that `rpcs` has the same keys as `chains`.
 *
 * @typeParam TChains - Record mapping user-chosen chain names to PAPI descriptors.
 *
 * @example
 * ```ts
 * import { createChainClient } from "@parity/product-sdk-chain-client";
 * import { paseo_asset_hub } from "./descriptors/paseo-asset-hub";
 * import { bulletin } from "./descriptors/bulletin";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub, bulletin },
 *     rpcs: {
 *         assetHub: ["wss://sys.ibp.network/asset-hub-paseo"],
 *         bulletin: ["wss://paseo-bulletin-rpc.polkadot.io"],
 *     },
 * });
 * ```
 */
export interface ChainClientConfig<
    TChains extends Record<string, ChainDefinition> = Record<string, ChainDefinition>,
> {
    /** Named chain descriptors (PAPI `ChainDefinition` objects). */
    chains: TChains;
    /** RPC endpoints per chain name. Must have an entry for each key in `chains`. */
    rpcs: { [K in keyof TChains]: readonly string[] };
    /** Optional per-chain connection metadata. */
    meta?: { [K in keyof TChains]?: ChainMeta };
}

/**
 * A connected chain client returned by {@link createChainClient}.
 *
 * Each key from your config maps to a fully-typed PAPI {@link TypedApi}.
 * Access raw `PolkadotClient` instances via `.raw` for advanced use cases
 * like creating an `InkSdk` for contract interactions.
 *
 * @typeParam TChains - The chain descriptor record used to create this client.
 *
 * @example
 * ```ts
 * // Typed API access — fully typed from your descriptors
 * const account = await client.assetHub.query.System.Account.getValue(addr);
 *
 * // Raw client for advanced use (e.g., InkSdk for contracts)
 * import { createInkSdk } from "@polkadot-api/sdk-ink";
 * const inkSdk = createInkSdk(client.raw.assetHub, { atBest: true });
 * ```
 */
export type ChainClient<TChains extends Record<string, ChainDefinition>> = {
    [K in string & keyof TChains]: TypedApi<TChains[K]>;
} & {
    /** Raw `PolkadotClient` instances, keyed by chain name. Use for advanced APIs like `createInkSdk`. */
    raw: { [K in string & keyof TChains]: PolkadotClient };
    /** Destroy all connections managed by this client. */
    destroy: () => void;
};

/** Internal per-chain state stored in the HMR-safe cache. */
export interface ChainEntry {
    client: PolkadotClient;
    api: Map<ChainDefinition, unknown>;
}
