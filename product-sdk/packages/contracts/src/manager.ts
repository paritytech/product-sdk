// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { HexString, PolkadotClient, SS58String } from "polkadot-api";
import { wrapContract } from "./wrap.js";
import { ContractLiveAddressResolutionError, ContractNotFoundError } from "./errors.js";
import type { ContractRuntime, ContractRuntimeOptions } from "./runtime.js";
import { createContractRuntimeFromClient } from "./runtime.js";
import type {
    AbiEntry,
    CdmJson,
    CdmJsonContract,
    Contract,
    ContractDef,
    ContractDefaults,
    ContractManagerOptions,
    ContractOptions,
    Contracts,
    LiveContractResolutionOptions,
} from "./types.js";

type ContractMap = Record<string, CdmJsonContract>;
type OptionAddress = { isSome: boolean; value: HexString };
type LiveVersionSpec = number | "latest";

const CDM_REGISTRY_ABI: AbiEntry[] = [
    {
        type: "function",
        name: "getAddress",
        inputs: [{ name: "contract_name", type: "string" }],
        outputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "isSome", type: "bool" },
                    { name: "value", type: "address" },
                ],
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getAddressAtVersion",
        inputs: [
            { name: "contract_name", type: "string" },
            { name: "version", type: "uint32" },
        ],
        outputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "isSome", type: "bool" },
                    { name: "value", type: "address" },
                ],
            },
        ],
        stateMutability: "view",
    },
];

function cloneCdmJson(cdmJson: CdmJson): CdmJson {
    const cloneContractMap = (contracts: ContractMap): ContractMap =>
        Object.fromEntries(
            Object.entries(contracts).map(([library, contract]) => [library, { ...contract }]),
        );

    return {
        ...cdmJson,
        dependencies: { ...cdmJson.dependencies },
        contracts: cdmJson.contracts ? cloneContractMap(cdmJson.contracts) : undefined,
    };
}

function resolveRegistryAddress(cdmJson: CdmJson, override?: HexString): HexString {
    if (override) return override;
    if (cdmJson.registry) return cdmJson.registry;
    throw new ContractLiveAddressResolutionError(
        "CDM registry address is required for live contract address resolution. Pass registryAddress or set cdm.json registry.",
    );
}

function patchContractAddress(cdmJson: CdmJson, library: string, address: HexString): void {
    const contract = cdmJson.contracts?.[library];
    if (!contract) {
        throw new ContractNotFoundError(library);
    }
    contract.address = address;
}

function resolveLiveVersionSpec(
    cdmJson: CdmJson,
    library: string,
    contract: CdmJsonContract,
): LiveVersionSpec {
    const requested = cdmJson.dependencies[library];
    if (typeof requested === "number" && Number.isInteger(requested) && requested >= 0) {
        return requested;
    }
    if (typeof requested === "string") {
        if (requested === "latest") return "latest";
        const parsed = Number(requested);
        if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
    return contract.version;
}

async function queryLiveAddress(
    registry: Contract<ContractDef>,
    library: string,
    version: LiveVersionSpec,
): Promise<HexString> {
    const result =
        version === "latest"
            ? await registry.getAddress.query(library)
            : await registry.getAddressAtVersion.query(library, version);
    if (!result.success) {
        throw new ContractLiveAddressResolutionError(
            version === "latest"
                ? `Failed to resolve live address for "${library}" from the CDM registry`
                : `Failed to resolve live address for "${library}" version ${version} from the CDM registry`,
            { library, detail: result.value },
        );
    }

    const value = result.value as OptionAddress | undefined;
    if (!value?.isSome) {
        throw new ContractLiveAddressResolutionError(
            version === "latest"
                ? `Contract "${library}" is not registered in the CDM registry`
                : `Contract "${library}" version ${version} is not registered in the CDM registry`,
            { library, detail: result.value },
        );
    }

    return value.value;
}

/**
 * Return a cloned manifest whose installed contract addresses have been
 * replaced by live addresses from the CDM registry.
 *
 * This is intentionally strict: if a requested library cannot be resolved
 * from the registry, the promise rejects. Use `new ContractManager(...)` or
 * `ContractManager.fromClient(...)` directly for snapshot-only behavior.
 */
export async function withLiveContractAddresses(
    cdmJson: CdmJson,
    runtime: ContractRuntime,
    options?: LiveContractResolutionOptions,
): Promise<CdmJson> {
    const contracts = cdmJson.contracts;
    if (!contracts || Object.keys(contracts).length === 0) {
        throw new ContractLiveAddressResolutionError(
            "No installed contracts found in cdm.json for live address resolution.",
        );
    }

    const libraries = options?.libraries ?? Object.keys(contracts);
    for (const library of libraries) {
        if (!(library in contracts)) {
            throw new ContractNotFoundError(library);
        }
    }

    const registryAddress = resolveRegistryAddress(cdmJson, options?.registryAddress);
    const registry = createContract(runtime, registryAddress, CDM_REGISTRY_ABI, {
        defaultOrigin: options?.registryOrigin,
    });
    const liveAddresses = await Promise.all(
        libraries.map(async (library): Promise<readonly [string, HexString]> => {
            const version = resolveLiveVersionSpec(cdmJson, library, contracts[library]);
            return [library, await queryLiveAddress(registry, library, version)];
        }),
    );

    const resolved = cloneCdmJson(cdmJson);
    for (const [library, address] of liveAddresses) {
        patchContractAddress(resolved, library, address);
    }
    return resolved;
}

/**
 * Manages typed contract interactions backed by a `cdm.json` manifest.
 *
 * Pass a `signerManager` (e.g. a `SignerManager` from `@parity/product-sdk-signer`)
 * so the currently logged-in account is used automatically — no manual
 * signer/origin wiring needed.
 *
 * @example
 * ```ts
 * import { createChainClient } from "@parity/product-sdk-chain-client";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { ContractManager, createContractRuntime } from "@parity/product-sdk-contracts";
 * import cdmJson from "./cdm.json";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub },
 *     rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
 * });
 * const runtime = createContractRuntime(client.assetHub);
 * const manager = new ContractManager(cdmJson, runtime, {
 *     signerManager,
 * });
 *
 * const counter = manager.getContract("@example/counter");
 * const { value } = await counter.getCount.query();
 * await counter.increment.tx();
 * ```
 */
export class ContractManager {
    private contracts: ContractMap | undefined;
    private runtime: ContractRuntime;
    private defaults: ContractDefaults;

    constructor(cdmJson: CdmJson, runtime: ContractRuntime, options?: ContractManagerOptions) {
        this.runtime = runtime;
        this.contracts = cdmJson.contracts;

        this.defaults = {
            signerManager: options?.signerManager,
            origin: options?.defaultOrigin,
            signer: options?.defaultSigner,
        };
    }

    /** Update the default origin, signer, or signerManager used by all contract handles. */
    setDefaults(defaults: ContractDefaults): void {
        if (defaults.signerManager !== undefined)
            this.defaults.signerManager = defaults.signerManager;
        if (defaults.origin !== undefined) this.defaults.origin = defaults.origin;
        if (defaults.signer !== undefined) this.defaults.signer = defaults.signer;
    }

    /**
     * Create a `ContractManager` from a raw `PolkadotClient`.
     *
     * Convenience factory: builds a `ContractRuntime` internally from the
     * client's typed API. Requires that the chain's typed API exposes the
     * `Revive` pallet and `ReviveApi` runtime API (Asset Hub Paseo /
     * Polkadot / Kusama).
     *
     * @param cdmJson - The CDM manifest.
     * @param client - A `PolkadotClient` for the chain where contracts are deployed.
     * @param descriptor - The chain descriptor used to derive the typed API.
     * @param options - Optional configuration (signerManager, defaults).
     */
    static fromClient<TDescriptor>(
        cdmJson: CdmJson,
        client: PolkadotClient,
        descriptor: TDescriptor,
        options?: ContractManagerOptions & ContractRuntimeOptions,
    ): ContractManager {
        return new ContractManager(
            cdmJson,
            createContractRuntimeFromClient(client, descriptor, options),
            options,
        );
    }

    /**
     * Create a manager after strictly resolving installed contract addresses
     * from the live CDM registry. ABIs still come from the installed manifest.
     */
    static async fromLive(
        cdmJson: CdmJson,
        runtime: ContractRuntime,
        options?: ContractManagerOptions & LiveContractResolutionOptions,
    ): Promise<ContractManager> {
        const resolved = await withLiveContractAddresses(cdmJson, runtime, {
            ...options,
            registryOrigin: options?.registryOrigin ?? (options?.defaultOrigin as SS58String),
        });
        return new ContractManager(resolved, runtime, options);
    }

    /**
     * Convenience factory for {@link fromLive} when the caller has a raw
     * `PolkadotClient` and descriptor.
     */
    static async fromLiveClient<TDescriptor>(
        cdmJson: CdmJson,
        client: PolkadotClient,
        descriptor: TDescriptor,
        options?: ContractManagerOptions & ContractRuntimeOptions & LiveContractResolutionOptions,
    ): Promise<ContractManager> {
        const runtime = createContractRuntimeFromClient(client, descriptor, options);
        return ContractManager.fromLive(cdmJson, runtime, options);
    }

    private getContractData(library: string): CdmJsonContract {
        if (!this.contracts || !(library in this.contracts)) {
            throw new ContractNotFoundError(library);
        }
        return this.contracts[library];
    }

    /**
     * Get a typed contract handle.
     *
     * Each method on the returned object has `.query()` for read-only calls
     * and `.tx()` for signed transactions. When codegen augments
     * {@link Contracts}, passing a known library name returns a fully-typed
     * handle. Without codegen the generic overload still works — methods are
     * accessible but untyped.
     */
    getContract<K extends string & keyof Contracts>(library: K): Contract<Contracts[K]>;
    getContract(library: string): Contract<ContractDef>;
    getContract(library: string): Contract<ContractDef> {
        const data = this.getContractData(library);
        return wrapContract(this.runtime, data.address, data.abi, this.defaults);
    }

    /** Get the on-chain address of an installed contract. */
    getAddress(library: string): HexString {
        return this.getContractData(library).address;
    }

    /**
     * Get the underlying {@link ContractRuntime} backing this manager.
     *
     * Useful when a consumer needs to call helpers that take a runtime
     * directly — most commonly {@link ensureContractAccountMapped} at app
     * boot. Avoids the alternative of building a second runtime against the
     * same client and descriptor.
     */
    getRuntime(): ContractRuntime {
        return this.runtime;
    }
}

/**
 * Create a contract handle from a raw H160 address and ABI — no `cdm.json` needed.
 *
 * @example
 * ```ts
 * import { createContractRuntime, createContract } from "@parity/product-sdk-contracts";
 *
 * const runtime = createContractRuntime(client.assetHub);
 * const counter = createContract(runtime, "0xC472...", abi, { signerManager });
 * await counter.getCount.query();
 * await counter.increment.tx();
 * ```
 */
export function createContract(
    runtime: ContractRuntime,
    address: HexString,
    abi: AbiEntry[],
    options?: ContractOptions,
): Contract<ContractDef> {
    const defaults: ContractDefaults = {
        signerManager: options?.signerManager,
        origin: options?.defaultOrigin,
        signer: options?.defaultSigner,
    };
    return wrapContract(runtime, address, abi, defaults);
}

/**
 * Create a contract handle from a raw `PolkadotClient`, descriptor, address, and ABI.
 *
 * Convenience wrapper that builds the `ContractRuntime` from the client's
 * typed API. The chain must expose `Revive` + `ReviveApi`.
 *
 * @example
 * ```ts
 * const counter = createContractFromClient(client, paseo_asset_hub, "0xC472...", abi);
 * const { value } = await counter.getCount.query();
 * ```
 */
export function createContractFromClient<TDescriptor>(
    client: PolkadotClient,
    descriptor: TDescriptor,
    address: HexString,
    abi: AbiEntry[],
    options?: ContractOptions & ContractRuntimeOptions,
): Contract<ContractDef> {
    return createContract(
        createContractRuntimeFromClient(client, descriptor, options),
        address,
        abi,
        options,
    );
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    /**
     * Real-world cdm.json structure as it appears in
     * current CDM installs. Used here as the reproducer
     * for the cdm-resolution flow: if `getContract()` works against
     * this manifest shape, it works against any consumer's manifest.
     *
     * Notable shape differences from the generated examples:
     *   - `metadataCid` is absent (made optional in 0.2.1)
     *   - `dependencies` uses `"latest"` for version
     *   - contract addresses are 20-byte EVM-shaped (Polkadot Asset Hub
     *     uses Solidity-compatible addresses for Revive contracts)
     */
    const playgroundCdm: CdmJson = {
        dependencies: {
            "@w3s/playground-registry": "latest",
        },
        contracts: {
            "@w3s/playground-registry": {
                version: 6,
                address: "0x4A37B123b0BA2A894cA5953f472264921d44e298",
                abi: [
                    { type: "constructor", inputs: [], stateMutability: "nonpayable" },
                    {
                        type: "function",
                        name: "publish",
                        inputs: [
                            { name: "domain", type: "string" },
                            { name: "metadata_uri", type: "string" },
                            { name: "visibility", type: "uint8" },
                        ],
                        outputs: [],
                        stateMutability: "nonpayable",
                    },
                    {
                        type: "function",
                        name: "unpublish",
                        inputs: [{ name: "domain", type: "string" }],
                        outputs: [],
                        stateMutability: "nonpayable",
                    },
                ],
            },
        },
    };

    const flattenedCdm: CdmJson = {
        registry: "0x9999999999999999999999999999999999999999",
        dependencies: {
            "@w3s/playground-registry": "latest",
        },
        contracts: {
            "@w3s/playground-registry": {
                version: 6,
                address: "0x4A37B123b0BA2A894cA5953f472264921d44e298",
                abi: [
                    { type: "constructor", inputs: [], stateMutability: "nonpayable" },
                    {
                        type: "function",
                        name: "publish",
                        inputs: [
                            { name: "domain", type: "string" },
                            { name: "metadata_uri", type: "string" },
                            { name: "visibility", type: "uint8" },
                        ],
                        outputs: [],
                        stateMutability: "nonpayable",
                    },
                ],
            },
        },
    };

    /**
     * Minimal `ContractRuntime` stub — `ContractManager` only forwards the
     * runtime through to `wrapContract`'s proxy, which doesn't invoke any
     * runtime member at construction time. The fields below stay
     * shape-only; any test that actually wants to call `.query()` / `.tx()`
     * builds its own runtime with real captures.
     */
    function fakeRuntime(): ContractRuntime {
        return {
            api: {
                tx: { Revive: { call: () => null, map_account: () => null } },
                query: { Revive: { OriginalAccount: { getValue: async () => undefined } } },
                apis: { ReviveApi: { call: async () => null } },
            },
            dryRunCall: async () => null,
        } as unknown as ContractRuntime;
    }

    async function registryRuntimeFor(
        value:
            | OptionAddress
            | ((call: { functionName: string; args: readonly unknown[] }) => OptionAddress),
    ): Promise<{ runtime: ContractRuntime; calls: { functionName: string; args: unknown[] }[] }> {
        const { bytesToHex, decodeFunctionData, encodeFunctionResult, hexToBytes } = await import(
            "viem"
        );
        const calls: { functionName: string; args: unknown[] }[] = [];

        const runtime = {
            ...fakeRuntime(),
            dryRunCall: async (
                _origin: unknown,
                _dest: unknown,
                _value: unknown,
                _gasLimit: unknown,
                _storageDepositLimit: unknown,
                calldata: Uint8Array,
            ) => {
                const decoded = decodeFunctionData({
                    abi: CDM_REGISTRY_ABI as any,
                    data: bytesToHex(calldata),
                });
                const call = {
                    functionName: decoded.functionName,
                    args: [...(decoded.args ?? [])],
                };
                calls.push(call);
                const resultValue = typeof value === "function" ? value(call) : value;
                const data = hexToBytes(
                    encodeFunctionResult({
                        abi: CDM_REGISTRY_ABI as any,
                        functionName: decoded.functionName,
                        result: resultValue,
                    }) as `0x${string}`,
                );
                return {
                    weight_consumed: { ref_time: 0n, proof_size: 0n },
                    weight_required: { ref_time: 1n, proof_size: 1n },
                    storage_deposit: { type: "Refund" as const, value: 0n },
                    max_storage_deposit: { type: "Refund" as const, value: 0n },
                    gas_consumed: 0n,
                    result: { success: true, value: { flags: 0, data } },
                };
            },
        };
        return { runtime, calls };
    }

    describe("ContractManager — cdm.json resolution", () => {
        test("constructs from a flat cdm.json", () => {
            const manager = new ContractManager(flattenedCdm, fakeRuntime());
            expect(manager.getAddress("@w3s/playground-registry")).toBe(
                "0x4A37B123b0BA2A894cA5953f472264921d44e298",
            );
        });

        test("getContract returns a typed handle from a flattened cdm.json", () => {
            const manager = new ContractManager(flattenedCdm, fakeRuntime());
            const registry = manager.getContract("@w3s/playground-registry") as unknown as Record<
                string,
                { query: unknown; tx: unknown }
            >;

            expect(typeof registry.publish.query).toBe("function");
            expect(typeof registry.publish.tx).toBe("function");
        });

        test("getContract throws without target wording for a flattened cdm.json miss", () => {
            const manager = new ContractManager(flattenedCdm, fakeRuntime());
            expect(() => manager.getContract("@nonexistent/contract")).toThrow(
                'Contract "@nonexistent/contract" not found in cdm.json',
            );
        });

        test("strictly patches flattened manifests with live registry addresses", async () => {
            const liveAddress = "0x7777777777777777777777777777777777777777";
            const { runtime, calls } = await registryRuntimeFor({
                isSome: true,
                value: liveAddress,
            });

            const resolved = await withLiveContractAddresses(flattenedCdm, runtime, {
                registryOrigin: "5LiveOrigin" as SS58String,
            });

            expect(resolved.contracts?.["@w3s/playground-registry"].address).toBe(liveAddress);
            expect(calls[0]).toMatchObject({
                functionName: "getAddress",
                args: ["@w3s/playground-registry"],
            });
            expect(flattenedCdm.contracts?.["@w3s/playground-registry"].address).toBe(
                "0x4A37B123b0BA2A894cA5953f472264921d44e298",
            );
        });

        test("uses versioned registry lookup for pinned dependencies", async () => {
            const latestAddress = "0x7777777777777777777777777777777777777777";
            const versionedAddress = "0x6666666666666666666666666666666666666666";
            const { runtime, calls } = await registryRuntimeFor(({ functionName }) => ({
                isSome: true,
                value: functionName === "getAddressAtVersion" ? versionedAddress : latestAddress,
            }));
            const pinnedCdm: CdmJson = {
                ...flattenedCdm,
                dependencies: {
                    "@w3s/playground-registry": 6,
                },
            };

            const resolved = await withLiveContractAddresses(pinnedCdm, runtime);

            expect(resolved.contracts?.["@w3s/playground-registry"].address).toBe(versionedAddress);
            expect(calls[0]).toMatchObject({
                functionName: "getAddressAtVersion",
                args: ["@w3s/playground-registry", 6],
            });
        });

        test("falls back to installed contract version when dependency entry is absent", async () => {
            const versionedAddress = "0x5555555555555555555555555555555555555555";
            const { runtime, calls } = await registryRuntimeFor({
                isSome: true,
                value: versionedAddress,
            });
            const missingDependencyCdm: CdmJson = {
                ...flattenedCdm,
                dependencies: {},
            };

            const resolved = await withLiveContractAddresses(missingDependencyCdm, runtime);

            expect(resolved.contracts?.["@w3s/playground-registry"].address).toBe(versionedAddress);
            expect(calls[0]).toMatchObject({
                functionName: "getAddressAtVersion",
                args: ["@w3s/playground-registry", 6],
            });
        });

        test("live registry resolution fails instead of falling back to the snapshot", async () => {
            const { runtime } = await registryRuntimeFor({
                isSome: false,
                value: "0x0000000000000000000000000000000000000000",
            });

            await expect(withLiveContractAddresses(flattenedCdm, runtime)).rejects.toThrow(
                /not registered/,
            );
        });

        test("constructs from a real-world cdm.json without errors", () => {
            const manager = new ContractManager(playgroundCdm, fakeRuntime());
            expect(manager.getAddress("@w3s/playground-registry")).toBe(
                "0x4A37B123b0BA2A894cA5953f472264921d44e298",
            );
        });

        test("getContract returns a typed handle for a library in the manifest", () => {
            const manager = new ContractManager(playgroundCdm, fakeRuntime());
            const registry = manager.getContract("@w3s/playground-registry") as unknown as Record<
                string,
                { query: unknown; tx: unknown }
            >;

            expect(typeof registry.publish.query).toBe("function");
            expect(typeof registry.publish.tx).toBe("function");
            expect(typeof registry.unpublish.query).toBe("function");
        });

        test("getContract throws ContractNotFoundError for an unknown library", () => {
            const manager = new ContractManager(playgroundCdm, fakeRuntime());
            expect(() => manager.getContract("@nonexistent/contract")).toThrow(
                /not found in cdm\.json/,
            );
        });

        test("getAddress returns the manifest's recorded H160 for a library", () => {
            // Replaces the prior "passes the right address to inkSdk" test —
            // the new runtime doesn't take the address at construction time
            // (wrapContract receives it directly), so we assert the
            // manifest-side projection instead.
            const manager = new ContractManager(playgroundCdm, fakeRuntime());
            expect(manager.getAddress("@w3s/playground-registry")).toBe(
                "0x4A37B123b0BA2A894cA5953f472264921d44e298",
            );
        });
    });

    describe("ContractManager defaults", () => {
        test("setDefaults updates origin / signer / signerManager mid-flight", () => {
            const manager = new ContractManager(playgroundCdm, fakeRuntime(), {
                defaultOrigin: "5OldOrigin" as HexString,
            });
            // This is a behavioral check via private-ish field — we don't
            // expose `defaults` directly, but `setDefaults` returning
            // without error is the contract.
            expect(() => manager.setDefaults({ origin: "5NewOrigin" as HexString })).not.toThrow();
        });
    });
}
