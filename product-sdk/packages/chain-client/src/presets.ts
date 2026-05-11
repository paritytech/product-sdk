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
import type { previewnet_asset_hub as PreviewnetAssetHubDef } from "@parity/product-sdk-descriptors/previewnet-asset-hub";
import type { paseo_bulletin as PaseoBulletinDef } from "@parity/product-sdk-descriptors/paseo-bulletin";
import type { previewnet_bulletin as PreviewnetBulletinDef } from "@parity/product-sdk-descriptors/previewnet-bulletin";
import type { paseo_individuality as PaseoIndividualityDef } from "@parity/product-sdk-descriptors/paseo-individuality";
import type { previewnet_individuality as PreviewnetIndividualityDef } from "@parity/product-sdk-descriptors/previewnet-individuality";

/** Known network environment with built-in descriptors and RPC endpoints. */
export type Environment = "polkadot" | "kusama" | "paseo" | "previewnet";

/** Environments where all chains (asset hub, bulletin, individuality) are live. */
const AVAILABLE_ENVIRONMENTS: Set<Environment> = new Set(["paseo", "previewnet"]);

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
        assetHub: [
            "wss://asset-hub-paseo-rpc.n.dwellir.com",
            "wss://sys.ibp.network/asset-hub-paseo",
        ],
        bulletin: [...BULLETIN_RPCS.paseo],
        individuality: ["wss://paseo-people-next-rpc.polkadot.io"],
    },
    previewnet: {
        assetHub: ["wss://previewnet.substrate.dev/asset-hub"],
        bulletin: [...BULLETIN_RPCS.previewnet],
        individuality: ["wss://previewnet.substrate.dev/people"],
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
        previewnet: () =>
            Promise.all([
                import("@parity/product-sdk-descriptors/previewnet-asset-hub"),
                import("@parity/product-sdk-descriptors/previewnet-bulletin"),
                import("@parity/product-sdk-descriptors/previewnet-individuality"),
            ]),
    };

    const [ahMod, bulletinMod, individualityMod] = await loaders[env]();

    // Extract the named exports — varies per environment. The fallback casts use
    // narrow shape types (not the full `typeof import(...)`) to keep formatter
    // wrap behavior compatible with esbuild's parser.
    const assetHub =
        "polkadot_asset_hub" in ahMod
            ? ahMod.polkadot_asset_hub
            : "kusama_asset_hub" in ahMod
              ? ahMod.kusama_asset_hub
              : "paseo_asset_hub" in ahMod
                ? ahMod.paseo_asset_hub
                : (ahMod as { previewnet_asset_hub: typeof PreviewnetAssetHubDef })
                      .previewnet_asset_hub;

    const bulletin =
        "paseo_bulletin" in bulletinMod
            ? bulletinMod.paseo_bulletin
            : (bulletinMod as { previewnet_bulletin: typeof PreviewnetBulletinDef })
                  .previewnet_bulletin;

    const individuality =
        "paseo_individuality" in individualityMod
            ? individualityMod.paseo_individuality
            : (individualityMod as { previewnet_individuality: typeof PreviewnetIndividualityDef })
                  .previewnet_individuality;

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
    previewnet: {
        assetHub: typeof PreviewnetAssetHubDef;
        bulletin: typeof PreviewnetBulletinDef;
        individuality: typeof PreviewnetIndividualityDef;
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
 * // Raw client for advanced use (e.g., InkSdk for contracts)
 * import { createInkSdk } from "@polkadot-api/sdk-ink";
 * const inkSdk = createInkSdk(client.raw.assetHub, { atBest: true });
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
    // Each chain has a per-environment genesis: bulletin and individuality
    // are distinct chain instances across paseo and previewnet (same runtime,
    // separate deployments).
    const GENESIS = {
        polkadot_asset_hub: "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
        kusama_asset_hub: "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a",
        paseo_asset_hub: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
        previewnet_asset_hub: "0x860d75a890388e2ad02c54aa451264d04af89765773a51cd56868b4293c7867c",
        paseo_bulletin: "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea",
        previewnet_bulletin: "0xf37fa1f1450ea120edbf64c3fc447f671a00e1f1095a698f42eeec073c7ee487",
        paseo_individuality: "0xa22a2424d2cbf561eaecf7da8b1b548fa9d1939f60265e942b1049616a012f71",
        previewnet_individuality:
            "0xbf3a38ecba96d2f647bc12198011b9e4f0ba3a7e2a190597205cbe238f5c125d",
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
        for (const env of ["polkadot", "kusama", "paseo", "previewnet"] as const) {
            const envRpcs = rpcs[env];
            expect(envRpcs.assetHub.length).toBeGreaterThan(0);
        }
    });

    test("paseo has RPCs for all chains", () => {
        const envRpcs = rpcs.paseo;
        expect(envRpcs.bulletin.length).toBeGreaterThan(0);
        expect(envRpcs.individuality.length).toBeGreaterThan(0);
    });

    test("previewnet has RPCs for all chains", () => {
        const envRpcs = rpcs.previewnet;
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

    test("loadDescriptors returns descriptors with genesis hashes for previewnet", async () => {
        const descriptors = await loadDescriptors("previewnet");
        expect(descriptors).toBeDefined();
        expect(descriptors.assetHub).toBeDefined();
        expect(descriptors.bulletin).toBeDefined();
        expect(descriptors.individuality).toBeDefined();
        expect(descriptors.assetHub.genesis).toBe(GENESIS.previewnet_asset_hub);
        expect(descriptors.bulletin.genesis).toBe(GENESIS.previewnet_bulletin);
        expect(descriptors.individuality.genesis).toBe(GENESIS.previewnet_individuality);
    });

    test("loadDescriptors returns environment-specific descriptors for every chain", async () => {
        const paseo = await loadDescriptors("paseo");
        const previewnet = await loadDescriptors("previewnet");
        // asset-hub: paseo and previewnet are different runtimes (different chains)
        expect(paseo.assetHub.genesis).toBe(GENESIS.paseo_asset_hub);
        expect(previewnet.assetHub.genesis).toBe(GENESIS.previewnet_asset_hub);
        // bulletin: same runtime, different chain instances → distinct genesis
        expect(paseo.bulletin.genesis).toBe(GENESIS.paseo_bulletin);
        expect(previewnet.bulletin.genesis).toBe(GENESIS.previewnet_bulletin);
        expect(paseo.bulletin.genesis).not.toBe(previewnet.bulletin.genesis);
        // individuality: same runtime, different chain instances → distinct genesis
        expect(paseo.individuality.genesis).toBe(GENESIS.paseo_individuality);
        expect(previewnet.individuality.genesis).toBe(GENESIS.previewnet_individuality);
        expect(paseo.individuality.genesis).not.toBe(previewnet.individuality.genesis);
    });

    // --- AVAILABLE_ENVIRONMENTS ---

    test("paseo and previewnet are currently available", () => {
        expect(AVAILABLE_ENVIRONMENTS.has("paseo")).toBe(true);
        expect(AVAILABLE_ENVIRONMENTS.has("previewnet")).toBe(true);
        expect(AVAILABLE_ENVIRONMENTS.has("polkadot")).toBe(false);
        expect(AVAILABLE_ENVIRONMENTS.has("kusama")).toBe(false);
    });
}
