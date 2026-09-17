// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition } from "polkadot-api";
import { createLogger } from "@parity/product-sdk-logger";
import { getHostChainInfo } from "@parity/product-sdk-host";
import type { HostChainDiscovery } from "@parity/product-sdk-host";
import { createChainClient } from "./clients.js";
import { CHAIN_IDENTIFIERS, type ENVIRONMENTS } from "./chain-names.js";
import { EnvironmentMismatchError, GenesisMismatchError } from "./errors.js";
import type { ChainClient } from "./types.js";

const log = createLogger("chain-client");

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
import type { previewnet_asset_hub as PreviewnetAssetHubDef } from "@parity/product-sdk-descriptors/previewnet-asset-hub";
import type { previewnet_bulletin as PreviewnetBulletinDef } from "@parity/product-sdk-descriptors/previewnet-bulletin";
import type { previewnet_individuality as PreviewnetIndividualityDef } from "@parity/product-sdk-descriptors/previewnet-individuality";
import type { devnet_asset_hub as DevnetAssetHubDef } from "@parity/product-sdk-descriptors/devnet-asset-hub";
import type { devnet_bulletin as DevnetBulletinDef } from "@parity/product-sdk-descriptors/devnet-bulletin";
import type { devnet_individuality as DevnetIndividualityDef } from "@parity/product-sdk-descriptors/devnet-individuality";

/**
 * Known network environment with built-in descriptors.
 *
 * - `"polkadot"` / `"kusama"` — production networks. Reserved: their Bulletin and
 *   Individuality chains are not live yet, so `getChainAPI` throws for both.
 * - `"paseo"` — the Paseo **Next v2** deployment
 * - `"previewnet"` — a zombienet deployment running a Paseo runtime, kept a step
 *   ahead of paseo-next-v2 so products can build against upcoming runtime changes
 *   early.
 * - `"devnet"` — the public "products devnet" on the Paseo **testnet** system
 *   chains, community-run by the
 *   Polkadot Community Foundation.
 */
export type Environment = (typeof ENVIRONMENTS)[number];

/** Environments where all chains (asset hub, bulletin, individuality) are live. */
const AVAILABLE_ENVIRONMENTS: Set<Environment> = new Set(["paseo", "previewnet", "devnet"]);

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
        devnet: () =>
            Promise.all([
                import("@parity/product-sdk-descriptors/devnet-asset-hub"),
                import("@parity/product-sdk-descriptors/devnet-bulletin"),
                import("@parity/product-sdk-descriptors/devnet-individuality"),
            ]),
    };

    const [ahMod, bulletinMod, individualityMod] = await loaders[env]();

    const assetHub =
        "polkadot_asset_hub" in ahMod
            ? ahMod.polkadot_asset_hub
            : "kusama_asset_hub" in ahMod
              ? ahMod.kusama_asset_hub
              : "devnet_asset_hub" in ahMod
                ? (ahMod as { devnet_asset_hub: typeof DevnetAssetHubDef }).devnet_asset_hub
                : "previewnet_asset_hub" in ahMod
                  ? (ahMod as { previewnet_asset_hub: typeof PreviewnetAssetHubDef })
                        .previewnet_asset_hub
                  : (ahMod as { paseo_asset_hub: typeof PaseoAssetHubDef }).paseo_asset_hub;

    const bulletin =
        "devnet_bulletin" in bulletinMod
            ? (bulletinMod as { devnet_bulletin: typeof DevnetBulletinDef }).devnet_bulletin
            : "previewnet_bulletin" in bulletinMod
              ? (bulletinMod as { previewnet_bulletin: typeof PreviewnetBulletinDef })
                    .previewnet_bulletin
              : (bulletinMod as { paseo_bulletin: typeof PaseoBulletinDef }).paseo_bulletin;

    const individuality =
        "devnet_individuality" in individualityMod
            ? (individualityMod as { devnet_individuality: typeof DevnetIndividualityDef })
                  .devnet_individuality
            : "previewnet_individuality" in individualityMod
              ? (
                    individualityMod as {
                        previewnet_individuality: typeof PreviewnetIndividualityDef;
                    }
                ).previewnet_individuality
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
    previewnet: {
        assetHub: typeof PreviewnetAssetHubDef;
        bulletin: typeof PreviewnetBulletinDef;
        individuality: typeof PreviewnetIndividualityDef;
    };
    devnet: {
        assetHub: typeof DevnetAssetHubDef;
        bulletin: typeof DevnetBulletinDef;
        individuality: typeof DevnetIndividualityDef;
    };
};

/** The chain shape returned by {@link getChainAPI} for a given environment. */
export type PresetChains<E extends Environment> = PresetDescriptors[E];

/** Import one environment's asset hub descriptor and read its genesis hash. */
const assetHubGenesis: Record<Environment, () => Promise<string | undefined>> = {
    polkadot: async () =>
        (await import("@parity/product-sdk-descriptors/polkadot-asset-hub")).polkadot_asset_hub
            .genesis,
    kusama: async () =>
        (await import("@parity/product-sdk-descriptors/kusama-asset-hub")).kusama_asset_hub.genesis,
    paseo: async () =>
        (await import("@parity/product-sdk-descriptors/paseo-asset-hub")).paseo_asset_hub.genesis,
    previewnet: async () =>
        (await import("@parity/product-sdk-descriptors/previewnet-asset-hub")).previewnet_asset_hub
            .genesis,
    devnet: async () =>
        (await import("@parity/product-sdk-descriptors/devnet-asset-hub")).devnet_asset_hub.genesis,
};

/** Live environments first so the probe usually stops at the first bundle. */
const PROBE_ORDER: readonly Environment[] = ["paseo", "previewnet", "devnet", "polkadot", "kusama"];

/**
 * Pick the effective environment: the one whose bundled asset hub carries
 * the discovered genesis hash. Hosts mint their own network ids, so matching
 * is by genesis, never by network string. Probes the requested environment
 * first, so the explicit happy path loads nothing extra.
 */
async function resolveEnvironment(
    env: Environment | undefined,
    discovery: HostChainDiscovery | null,
): Promise<Environment> {
    if (discovery === null) {
        if (!env) {
            throw new Error(
                'getChainAPI: the host did not report a usable network via chain discovery; pass an explicit environment, e.g. getChainAPI("paseo").',
            );
        }
        return env;
    }
    const discovered = discovery.chains.AssetHub?.toLowerCase();
    let matched: Environment | null = null;
    if (discovered) {
        const candidates = env ? [env, ...PROBE_ORDER.filter((e) => e !== env)] : PROBE_ORDER;
        for (const candidate of candidates) {
            // A bundle that fails to load is just a candidate that cannot
            // match. Every environment is probed, including ones unrelated to
            // the host, so one broken chunk must not take down the call.
            let genesis: string | undefined;
            try {
                genesis = await assetHubGenesis[candidate]();
            } catch (error) {
                log.warn(
                    `Could not load the "${candidate}" asset hub descriptor while deriving the environment`,
                    error,
                );
                continue;
            }
            if (genesis?.toLowerCase() === discovered) {
                matched = candidate;
                break;
            }
        }
    }
    if (env) {
        if (matched && matched !== env) throw new EnvironmentMismatchError(env, discovery.network);
        // No match means the host's asset hub is unknown. Descriptor
        // validation below reports that as a genesis mismatch.
        return env;
    }
    if (!matched) {
        throw new Error(
            `getChainAPI: no bundled descriptors match the host's chains (network "${discovery.network}"); pass an explicit environment.`,
        );
    }
    return matched;
}

/**
 * Cross-check each bundled descriptor against the host's resolved chains.
 * Identifiers the host refused are absent from the discovery result and are
 * left to the existing deferred ChainNotSupportedError path.
 *
 * Only the asset hub is fatal: it anchors the environment, so a mismatch there
 * means the whole bundle is the wrong one. The other chains are re-genesised
 * individually (paseo individuality has been, with the asset hub untouched), and
 * failing the call would take the chains that do match down with them. Those
 * warn here and `createChainClient` hands back an api that throws
 * `ChainNotSupportedError` on use, which is the same treatment any chain the
 * host cannot serve already gets.
 */
function validateDescriptorGenesis(
    descriptors: Record<keyof typeof CHAIN_IDENTIFIERS, ChainDefinition>,
    discovery: HostChainDiscovery,
): void {
    for (const [key, identifier] of Object.entries(CHAIN_IDENTIFIERS)) {
        const hostGenesis = discovery.chains[identifier];
        const genesis = descriptors[key as keyof typeof CHAIN_IDENTIFIERS]?.genesis;
        if (!hostGenesis || !genesis) continue;
        if (genesis.toLowerCase() === hostGenesis.toLowerCase()) continue;
        if (key === "assetHub") throw new GenesisMismatchError(key, genesis, hostGenesis);
        log.warn(
            `Bundled "${key}" descriptor expects genesis ${genesis} but the host serves ${hostGenesis}; that chain will throw on use. Update @parity/product-sdk-descriptors.`,
        );
    }
}

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
 * When called with no argument, the environment is derived from the host via
 * chain discovery. This is the recommended mode inside a
 * container. The zero-arg form is typed with the "paseo" shape, and runtime
 * descriptors always match the host's actual network. It needs a host that
 * serves discovery: outside a container, or on a host that predates it, the
 * zero-arg form throws and the environment has to be passed explicitly.
 *
 * An explicit environment that disagrees with the host's network throws
 * {@link EnvironmentMismatchError}. A bundled asset hub descriptor whose
 * genesis hash disagrees with the host throws {@link GenesisMismatchError},
 * since it anchors the environment; a mismatch on bulletin or individuality
 * warns and leaves that one chain throwing on use. Hosts that predate
 * discovery skip validation entirely.
 *
 * @example
 * Let the host decide, the recommended path inside a container:
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 *
 * const client = await getChainAPI();
 * const account = await client.assetHub.query.System.Account.getValue(addr);
 * client.destroy();
 * ```
 *
 * @example
 * Pin the environment explicitly:
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
export async function getChainAPI(): Promise<ChainClient<PresetChains<"paseo">>>;
export async function getChainAPI<E extends Environment>(
    env: E,
): Promise<ChainClient<PresetChains<E>>>;
export async function getChainAPI(envArg?: Environment): Promise<any> {
    // "Relay" is not probed because there is no relay preset descriptor.
    const discovery = await getHostChainInfo(Object.values(CHAIN_IDENTIFIERS));
    const env = await resolveEnvironment(envArg, discovery);

    if (!AVAILABLE_ENVIRONMENTS.has(env)) {
        throw new Error(`Chain API for "${env}" is not yet available`);
    }

    const descriptors = await loadDescriptors(env);
    if (discovery) validateDescriptorGenesis(descriptors, discovery);

    return createChainClient({
        chains: {
            assetHub: descriptors.assetHub,
            bulletin: descriptors.bulletin,
            individuality: descriptors.individuality,
        },
    });
}

if (import.meta.vitest) {
    const { test, expect, beforeEach, vi } = import.meta.vitest;
    const { destroyAll } = await import("./clients.js");
    const { EnvironmentMismatchError, GenesisMismatchError } = await import("./errors.js");

    // Test-only genesis hashes for assertion — not used in production code.
    const GENESIS = {
        polkadot_asset_hub: "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
        kusama_asset_hub: "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a",
        paseo_asset_hub: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
        paseo_bulletin: "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
        paseo_individuality: "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48",
        previewnet_asset_hub: "0xc27c8bf3f13f96dc2130cd2b0a3debe57618fd02521ecc1902bd7dd4ed83d2fe",
        previewnet_bulletin: "0xea9158d768971553e315b76323cbffda238b6b865f3d3d5e138350b12312173d",
        previewnet_individuality:
            "0xf720c28fe3315e67fa799a616fc59abad47dd257b1a336af6538435844d35218",
        devnet_asset_hub: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
        devnet_bulletin: "0xe101f0fa4627d29a257645e02be86d80378fea1a2bf8fa6a918d150ebc760a59",
        devnet_individuality: "0xe6c30d6e148f250b887105237bcaa5cb9f16dd203bf7b5b9d4f1da7387cb86ec",
    } as const;

    beforeEach(() => {
        destroyAll();
        discoveryState.discovery = null;
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

    test("loadDescriptors returns descriptors with genesis hashes for devnet", async () => {
        const descriptors = await loadDescriptors("devnet");
        expect(descriptors).toBeDefined();
        expect(descriptors.assetHub).toBeDefined();
        expect(descriptors.bulletin).toBeDefined();
        expect(descriptors.individuality).toBeDefined();
        expect(descriptors.assetHub.genesis).toBe(GENESIS.devnet_asset_hub);
        expect(descriptors.bulletin.genesis).toBe(GENESIS.devnet_bulletin);
        expect(descriptors.individuality.genesis).toBe(GENESIS.devnet_individuality);
    });

    // --- AVAILABLE_ENVIRONMENTS ---

    test("paseo, previewnet and devnet are currently available", () => {
        expect(AVAILABLE_ENVIRONMENTS.has("paseo")).toBe(true);
        expect(AVAILABLE_ENVIRONMENTS.has("previewnet")).toBe(true);
        expect(AVAILABLE_ENVIRONMENTS.has("devnet")).toBe(true);
        expect(AVAILABLE_ENVIRONMENTS.has("polkadot")).toBe(false);
        expect(AVAILABLE_ENVIRONMENTS.has("kusama")).toBe(false);
    });

    // --- chain discovery ---

    // Partial mocks: getHostChainInfo is driven by test state; createChainClient
    // is captured so success paths don't dial a real host. All other exports stay real.
    const discoveryState = vi.hoisted(() => ({
        discovery: null as null | {
            network: string;
            chains: Partial<Record<string, string>>;
        },
        createChainClientCalls: [] as unknown[],
    }));

    vi.mock("@parity/product-sdk-host", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@parity/product-sdk-host")>()),
        getHostChainInfo: async () => discoveryState.discovery,
    }));

    vi.mock("./clients.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("./clients.js")>()),
        createChainClient: async (config: unknown) => {
            discoveryState.createChainClientCalls.push(config);
            return { fake: true };
        },
    }));

    // The network id is deliberately dotli's spelling, not "paseo". Derivation
    // must work from the genesis hashes alone.
    const HOST_PASEO = {
        network: "paseo-next-v2",
        chains: {
            AssetHub: GENESIS.paseo_asset_hub,
            Bulletin: GENESIS.paseo_bulletin,
            People: GENESIS.paseo_individuality,
        },
    };

    test("legacy host + no env throws a clear error", async () => {
        discoveryState.discovery = null;
        await expect(getChainAPI()).rejects.toThrow(/pass an explicit environment/);
    });

    test("legacy host + explicit env behaves as today", async () => {
        discoveryState.discovery = null;
        discoveryState.createChainClientCalls = [];
        await getChainAPI("paseo");
        expect(discoveryState.createChainClientCalls.length).toBe(1);
    });

    test("derives the environment from the discovered asset hub genesis", async () => {
        discoveryState.discovery = HOST_PASEO;
        discoveryState.createChainClientCalls = [];
        await getChainAPI();
        const config = discoveryState.createChainClientCalls[0] as {
            chains: Record<string, { genesis?: string }>;
        };
        expect(config.chains.assetHub.genesis).toBe(GENESIS.paseo_asset_hub);
    });

    test("explicit env mismatching the host's chains throws EnvironmentMismatchError", async () => {
        discoveryState.discovery = HOST_PASEO;
        const error = await getChainAPI("devnet").catch((e) => e);
        expect(error).toBeInstanceOf(EnvironmentMismatchError);
        expect(error.requested).toBe("devnet");
        expect(error.hostNetwork).toBe("paseo-next-v2");
    });

    test("no matching bundle + no env throws naming the host network", async () => {
        discoveryState.discovery = { network: "westend", chains: {} };
        await expect(getChainAPI()).rejects.toThrow(/no bundled descriptors match.*"westend"/);
    });

    test("descriptor genesis disagreeing with the host throws GenesisMismatchError", async () => {
        discoveryState.discovery = {
            network: "paseo",
            chains: { AssetHub: "0xdeadbeef" },
        };
        const error = await getChainAPI("paseo").catch((e) => e);
        expect(error).toBeInstanceOf(GenesisMismatchError);
        expect(error.chain).toBe("assetHub");
        expect(error.hostGenesis).toBe("0xdeadbeef");
    });

    test("a non-anchor genesis mismatch warns and keeps the other chains usable", async () => {
        // paseo individuality has been re-genesised on its own before, with the
        // asset hub untouched (descriptors 0.5.1). Failing the whole call would
        // take asset hub and bulletin down with it.
        discoveryState.discovery = {
            network: "paseo",
            chains: {
                AssetHub: GENESIS.paseo_asset_hub,
                Bulletin: GENESIS.paseo_bulletin,
                People: "0xstale",
            },
        };
        discoveryState.createChainClientCalls = [];
        await getChainAPI("paseo");
        expect(discoveryState.createChainClientCalls.length).toBe(1);
    });

    test("identifiers the host refuses skip validation", async () => {
        discoveryState.discovery = {
            network: "paseo",
            chains: { AssetHub: GENESIS.paseo_asset_hub },
        };
        discoveryState.createChainClientCalls = [];
        await getChainAPI("paseo");
        expect(discoveryState.createChainClientCalls.length).toBe(1);
    });

    test("derived reserved environments still throw not-yet-available", async () => {
        discoveryState.discovery = {
            network: "polkadot",
            chains: { AssetHub: GENESIS.polkadot_asset_hub },
        };
        await expect(getChainAPI()).rejects.toThrow("not yet available");
    });
}
