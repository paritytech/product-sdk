// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition } from "polkadot-api";
import { createChainClient } from "./clients.js";
import type { ChainClient } from "./types.js";

// Type-only imports — erased at compile time, zero bundle cost.
// These give us per-chain TypedApi types without importing runtime descriptor data.
// Every environment ships its own descriptor for each chain (asset hub, bulletin,
// individuality) so that genesis hashes and metadata reflect the live chain
// instance the consumer connects to.
import type { polkadot_asset_hub as PolkadotAssetHubDef } from "@parity/product-sdk-descriptors/polkadot-asset-hub";
import type { kusama_asset_hub as KusamaAssetHubDef } from "@parity/product-sdk-descriptors/kusama-asset-hub";
import type { paseo_asset_hub as PaseoAssetHubDef } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import type { paseo_bulletin as PaseoBulletinDef } from "@parity/product-sdk-descriptors/paseo-bulletin";
import type { paseo_individuality as PaseoIndividualityDef } from "@parity/product-sdk-descriptors/paseo-individuality";
import type { summit_asset_hub as SummitAssetHubDef } from "@parity/product-sdk-descriptors/summit-asset-hub";
import type { summit_bulletin as SummitBulletinDef } from "@parity/product-sdk-descriptors/summit-bulletin";
import type { summit_individuality as SummitIndividualityDef } from "@parity/product-sdk-descriptors/summit-individuality";

/** Known network environment with built-in descriptors. */
export type Environment = "polkadot" | "kusama" | "paseo" | "summit";

/** Environments where all chains (asset hub, bulletin, individuality) are live. */
const AVAILABLE_ENVIRONMENTS: Set<Environment> = new Set(["paseo", "summit"]);

/**
 * Lazy-load descriptors for a specific environment.
 *
 * Every chain (asset hub, bulletin, individuality) ships a per-environment
 * descriptor so that genesis hashes and metadata reflect the live chain
 * instance the consumer connects to. Dynamic imports are code-split per
 * environment, so a consumer using one environment doesn't bundle the others.
 */
async function loadDescriptors(env: Environment) {
    const loaders = {
        polkadot: () =>
            Promise.all([
                import("@parity/product-sdk-descriptors/polkadot-asset-hub"),
                // Polkadot bulletin/individuality are not yet live; gated by
                // AVAILABLE_ENVIRONMENTS so this branch is unreachable today.
                Promise.reject(new Error("polkadot bulletin descriptor not yet available")),
                Promise.reject(new Error("polkadot individuality descriptor not yet available")),
            ]),
        kusama: () =>
            Promise.all([
                import("@parity/product-sdk-descriptors/kusama-asset-hub"),
                Promise.reject(new Error("kusama bulletin descriptor not yet available")),
                Promise.reject(new Error("kusama individuality descriptor not yet available")),
            ]),
        paseo: () =>
            Promise.all([
                import("@parity/product-sdk-descriptors/paseo-asset-hub"),
                import("@parity/product-sdk-descriptors/paseo-bulletin"),
                import("@parity/product-sdk-descriptors/paseo-individuality"),
            ]),
        summit: () =>
            Promise.all([
                import("@parity/product-sdk-descriptors/summit-asset-hub"),
                import("@parity/product-sdk-descriptors/summit-bulletin"),
                import("@parity/product-sdk-descriptors/summit-individuality"),
            ]),
    };

    const [ahMod, bulletinMod, individualityMod] = await loaders[env]();

    const assetHub =
        "polkadot_asset_hub" in ahMod
            ? ahMod.polkadot_asset_hub
            : "kusama_asset_hub" in ahMod
              ? ahMod.kusama_asset_hub
              : "summit_asset_hub" in ahMod
                ? (ahMod as { summit_asset_hub: typeof SummitAssetHubDef }).summit_asset_hub
                : (ahMod as { paseo_asset_hub: typeof PaseoAssetHubDef }).paseo_asset_hub;

    const bulletin =
        "summit_bulletin" in bulletinMod
            ? (bulletinMod as { summit_bulletin: typeof SummitBulletinDef }).summit_bulletin
            : (bulletinMod as { paseo_bulletin: typeof PaseoBulletinDef }).paseo_bulletin;

    const individuality =
        "summit_individuality" in individualityMod
            ? (individualityMod as { summit_individuality: typeof SummitIndividualityDef })
                  .summit_individuality
            : (individualityMod as { paseo_individuality: typeof PaseoIndividualityDef })
                  .paseo_individuality;

    return { assetHub, bulletin, individuality };
}

/** Per-environment descriptor types for each chain in the preset. */
type PresetDescriptors = {
    polkadot: {
        assetHub: typeof PolkadotAssetHubDef;
        // Bulletin/individuality not yet live on polkadot — types reuse paseo
        // shape so the API surface stays consistent; runtime path is gated.
        bulletin: typeof PaseoBulletinDef;
        individuality: typeof PaseoIndividualityDef;
    };
    kusama: {
        assetHub: typeof KusamaAssetHubDef;
        bulletin: typeof PaseoBulletinDef;
        individuality: typeof PaseoIndividualityDef;
    };
    paseo: {
        assetHub: typeof PaseoAssetHubDef;
        bulletin: typeof PaseoBulletinDef;
        individuality: typeof PaseoIndividualityDef;
    };
    summit: {
        assetHub: typeof SummitAssetHubDef;
        bulletin: typeof SummitBulletinDef;
        individuality: typeof SummitIndividualityDef;
    };
};

/** The chain shape returned by {@link getChainAPI} for a given environment. */
export type PresetChains<E extends Environment> = PresetDescriptors[E];

/**
 * Get a chain client for a known environment with built-in descriptors.
 *
 * This is the **zero-config** path — no need to import descriptors or specify
 * endpoints. For custom chains or BYOD descriptors, use
 * {@link createChainClient} instead.
 *
 * Returns the same {@link ChainClient} type as `createChainClient`, with
 * `assetHub`, `bulletin`, and `individuality` chain keys.
 *
 * @example
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 *
 * const client = await getChainAPI("paseo");
 *
 * // Fully typed — no descriptor imports needed
 * const account = await client.assetHub.query.System.Account.getValue(addr);
 * const fee = await client.bulletin.query.TransactionStorage.ByteFee.getValue();
 *
 * // Raw client for advanced use (e.g., a ContractRuntime for pallet-revive contracts)
 * import { createContractRuntimeFromClient } from "@parity/product-sdk-contracts";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub);
 *
 * client.destroy();
 * ```
 */
export async function getChainAPI<E extends Environment>(
    env: E,
): Promise<ChainClient<PresetChains<E>>> {
    if (!AVAILABLE_ENVIRONMENTS.has(env)) {
        throw new Error(`Chain API for "${env}" is not yet available`);
    }

    const descriptors = await loadDescriptors(env);

    return createChainClient({
        chains: {
            assetHub: descriptors.assetHub,
            bulletin: descriptors.bulletin,
            individuality: descriptors.individuality,
        },
    }) as Promise<ChainClient<PresetChains<E>>>;
}

if (import.meta.vitest) {
    const { test, expect, beforeEach } = import.meta.vitest;
    const { destroyAll } = await import("./clients.js");

    // Test-only genesis hashes for assertion — not used in production code.
    const GENESIS = {
        polkadot_asset_hub: "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
        kusama_asset_hub: "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a",
        paseo_asset_hub: "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
        paseo_bulletin: "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
        paseo_individuality: "0xc5af1826b31493f08b7e2a823842f98575b806a784126f28da9608c68665afa5",
        summit_asset_hub: "0xf388dc6d6cdf6fb77eac3c4a91f31bc0c8642b142f1a757512ab7849f9f70660",
        summit_bulletin: "0x147aae0d60625af72300d4d5ebd5dcb869f7ac4c6c1a326be1cbb14a4a65ae77",
        summit_individuality: "0xbe5238f82c3553bc57ac3be43bef110bd58c49ad0744110814985195ca7d8c4e",
    } as const;

    beforeEach(() => {
        destroyAll();
    });

    // --- GENESIS constants ---

    test("genesis constants are valid hex hashes", () => {
        for (const hash of Object.values(GENESIS)) {
            expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
        }
    });

    // --- getChainAPI ---

    test("polkadot and kusama throw as not yet available", async () => {
        await expect(getChainAPI("polkadot")).rejects.toThrow("not yet available");
        await expect(getChainAPI("kusama")).rejects.toThrow("not yet available");
    });

    // --- loadDescriptors ---

    test("loadDescriptors returns descriptors with genesis hashes for paseo", async () => {
        const descriptors = await loadDescriptors("paseo");
        expect(descriptors).toBeDefined();
        expect(descriptors.assetHub).toBeDefined();
        expect(descriptors.bulletin).toBeDefined();
        expect(descriptors.individuality).toBeDefined();
        expect(descriptors.assetHub.genesis).toBe(GENESIS.paseo_asset_hub);
        expect(descriptors.bulletin.genesis).toBe(GENESIS.paseo_bulletin);
        expect(descriptors.individuality.genesis).toBe(GENESIS.paseo_individuality);
    });

    test("loadDescriptors returns descriptors with genesis hashes for summit", async () => {
        const descriptors = await loadDescriptors("summit");
        expect(descriptors).toBeDefined();
        expect(descriptors.assetHub).toBeDefined();
        expect(descriptors.bulletin).toBeDefined();
        expect(descriptors.individuality).toBeDefined();
        expect(descriptors.assetHub.genesis).toBe(GENESIS.summit_asset_hub);
        expect(descriptors.bulletin.genesis).toBe(GENESIS.summit_bulletin);
        expect(descriptors.individuality.genesis).toBe(GENESIS.summit_individuality);
    });

    // --- AVAILABLE_ENVIRONMENTS ---

    test("paseo and summit are currently available", () => {
        expect(AVAILABLE_ENVIRONMENTS.has("paseo")).toBe(true);
        expect(AVAILABLE_ENVIRONMENTS.has("summit")).toBe(true);
        expect(AVAILABLE_ENVIRONMENTS.has("polkadot")).toBe(false);
        expect(AVAILABLE_ENVIRONMENTS.has("kusama")).toBe(false);
    });
}
