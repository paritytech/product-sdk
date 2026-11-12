// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition, PolkadotClient, TypedApi } from "polkadot-api";

/**
 * Configuration for {@link createChainClient}.
 *
 * Provide named chain descriptors. The SDK routes all connections through the
 * host provider, so no RPC endpoints are required, and only chains the host routes
 * are reachable.
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
 * });
 * ```
 */
export interface ChainClientConfig<
    TChains extends Record<string, ChainDefinition> = Record<string, ChainDefinition>,
> {
    /** Named chain descriptors (PAPI `ChainDefinition` objects). */
    chains: TChains;
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
    /**
     * Raw `PolkadotClient` instances, keyed by chain name. Use for advanced APIs
     * like `createContractRuntime`.
     *
     * Each one is the product's single client for that chain, shared with every
     * other `createChainClient` config and SDK package that uses the chain.
     * Calling `.destroy()` on it directly tears the chain down for all of them;
     * release this client's hold with {@link ChainClient.destroy} instead.
     */
    raw: { [K in string & keyof TChains]: PolkadotClient };
    /**
     * Release this client's hold on each of its chains. A chain's shared
     * connection closes once no other client holds it. Safe to call more than
     * once.
     */
    destroy: () => void;
};

/**
 * A chain's single shared `PolkadotClient`, held in the HMR-safe cache under
 * its genesis hash and counted by how many {@link ChainClient}s use it.
 */
export interface SharedChain {
    /** The client, or the promise of it while it is being created. */
    client: PolkadotClient | Promise<PolkadotClient>;
    /** Typed APIs built over the client, one per descriptor. */
    api: Map<ChainDefinition, unknown>;
    /** How many `ChainClient`s hold this chain. The client closes at zero. */
    users: number;
}

/** @deprecated Use {@link SharedChain}. */
export type ChainEntry = SharedChain;
