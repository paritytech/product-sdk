// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition, PolkadotClient, TypedApi } from "polkadot-api";

/** Supported chain environments for the Polkadot ecosystem. */
export type Environment = "polkadot" | "kusama" | "paseo" | "local" | "westend";

/**
 * Configuration for {@link createChainClient}.
 *
 * Provide named chain descriptors and their RPC endpoints.
 * TypeScript enforces that `rpcs` has the same keys as `chains`.
 *
 * Note: The SDK routes all connections through the host provider. The `rpcs`
 * field is currently unused but kept for API compatibility.
 *
 * @typeParam TChains - Record mapping user-chosen chain names to PAPI descriptors.
 *
 * @example
 * ```ts
 * import { createChainClient } from "@parity/product-sdk-chain-client";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub, bulletin: paseo_bulletin },
 *     rpcs: {
 *         assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"],
 *         bulletin: ["wss://paseo-bulletin-next-rpc.polkadot.io"],
 *     },
 * });
 * ```
 */
export interface ChainClientConfig<
    TChains extends Record<string, ChainDefinition> = Record<string, ChainDefinition>,
> {
    /** Named chain descriptors (PAPI `ChainDefinition` objects). */
    chains: TChains;
    /** RPC endpoints per chain name (currently unused - connections route through host). */
    rpcs: { [K in keyof TChains]: readonly string[] };
}

/**
 * A connected chain client returned by {@link createChainClient}.
 *
 * Each key from your config maps to a fully-typed PAPI {@link TypedApi}.
 * Access raw `PolkadotClient` instances via `.raw` for advanced use cases
 * like creating a `ContractRuntime` for pallet-revive contract interactions.
 *
 * @typeParam TChains - The chain descriptor record used to create this client.
 *
 * @example
 * ```ts
 * // Typed API access — fully typed from your descriptors
 * const account = await client.assetHub.query.System.Account.getValue(addr);
 *
 * // Raw client for advanced use (e.g., a ContractRuntime for pallet-revive contracts)
 * import { createContractRuntimeFromClient } from "@parity/product-sdk-contracts";
 * const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub);
 * ```
 */
export type ChainClient<TChains extends Record<string, ChainDefinition>> = {
    [K in string & keyof TChains]: TypedApi<TChains[K]>;
} & {
    /** Raw `PolkadotClient` instances, keyed by chain name. Use for advanced APIs like `createContractRuntime`. */
    raw: { [K in string & keyof TChains]: PolkadotClient };
    /** Destroy all connections managed by this client. */
    destroy: () => void;
};

/** Internal per-chain state stored in the HMR-safe cache. */
export interface ChainEntry {
    client: PolkadotClient;
    api: Map<ChainDefinition, unknown>;
}
