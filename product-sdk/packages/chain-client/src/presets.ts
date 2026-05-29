// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition } from "polkadot-api";
import { BULLETIN_RPCS } from "@parity/product-sdk-host";
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

/** Known network environment with built-in descriptors and RPC endpoints. */
export type Environment = "polkadot" | "kusama" | "paseo";

/** Environments where all chains (asset hub, bulletin, individuality) are live. */
const AVAILABLE_ENVIRONMENTS: Set<Environment> = new Set(["paseo"]);

const rpcs = {
    polkadot: {
        assetHub: [
            "wss://polkadot-asset-hub-rpc.polkadot.io",
            "wss://sys.ibp.network/asset-hub-polkadot",
        ],
        bulletin: [...BULLETIN_RPCS.polkadot],
        individuality: [] as string[],
    },
    kusama: {
        assetHub: [
            "wss://kusama-asset-hub-rpc.polkadot.io",
            "wss://sys.ibp.network/asset-hub-kusama",
        ],
        bulletin: [...BULLETIN_RPCS.kusama],
        individuality: [] as string[],
    },
    paseo: {
        assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"],
        bulletin: [...BULLETIN_RPCS.paseo],
        individuality: ["wss://paseo-people-next-system-rpc.polkadot.io"],
    },
} as const;

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
    };

    const [ahMod, bulletinMod, individualityMod] = await loaders[env]();

    const assetHub =
        "polkadot_asset_hub" in ahMod
            ? ahMod.polkadot_asset_hub
            : "kusama_asset_hub" in ahMod
              ? ahMod.kusama_asset_hub
              : (ahMod as { paseo_asset_hub: typeof PaseoAssetHubDef }).paseo_asset_hub;

    const bulletin = (bulletinMod as { paseo_bulletin: typeof PaseoBulletinDef }).paseo_bulletin;

    const individuality = (
        individualityMod as { paseo_individuality: typeof PaseoIndividualityDef }
    ).paseo_individuality;

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
};

/** The chain shape returned by {@link getChainAPI} for a given environment. */
export type PresetChains<E extends Environment> = PresetDescriptors[E];

/**
 * Get a chain client for a known environment with built-in descriptors and RPCs.
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
    const envRpcs = rpcs[env];

    return createChainClient({
        chains: {
            assetHub: descriptors.assetHub,
            bulletin: descriptors.bulletin,
            individuality: descriptors.individuality,
        },
        rpcs: {
            assetHub: [...envRpcs.assetHub],
            bulletin: [...envRpcs.bulletin],
            individuality: [...envRpcs.individuality],
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
        paseo_asset_hub: "0x173cea9df45656cf612c8b8ece56e04e9a693c69cfaac47d3628dae735067af8",
        paseo_bulletin: "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
        paseo_individuality: "0x053e1a785bb0990b98768124d9609e963d9ca3558f5ac6e90a4297aaa0a0bd4b",
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

    // --- RPC config ---

    test("rpcs defined for all environments", () => {
        for (const env of ["polkadot", "kusama", "paseo"] as const) {
            const envRpcs = rpcs[env];
            expect(envRpcs.assetHub.length).toBeGreaterThan(0);
        }
    });

    test("paseo has RPCs for all chains", () => {
        const envRpcs = rpcs.paseo;
        expect(envRpcs.bulletin.length).toBeGreaterThan(0);
        expect(envRpcs.individuality.length).toBeGreaterThan(0);
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

    // --- AVAILABLE_ENVIRONMENTS ---

    test("paseo is currently available", () => {
        expect(AVAILABLE_ENVIRONMENTS.has("paseo")).toBe(true);
        expect(AVAILABLE_ENVIRONMENTS.has("polkadot")).toBe(false);
        expect(AVAILABLE_ENVIRONMENTS.has("kusama")).toBe(false);
    });
}
