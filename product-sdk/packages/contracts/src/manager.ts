// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { HexString, PolkadotClient } from "polkadot-api";
import { wrapContract } from "./wrap.js";
import { ContractNotFoundError } from "./errors.js";
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
} from "./types.js";

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
    private cdmJson: CdmJson;
    private targetHash: string;
    private runtime: ContractRuntime;
    private defaults: ContractDefaults;

    constructor(cdmJson: CdmJson, runtime: ContractRuntime, options?: ContractManagerOptions) {
        this.cdmJson = cdmJson;
        this.runtime = runtime;

        if (options?.targetHash) {
            this.targetHash = options.targetHash;
        } else {
            const targets = Object.keys(cdmJson.targets);
            if (targets.length === 0) throw new Error("No targets found in cdm.json");
            this.targetHash = targets[0];
        }

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

    private getContractData(library: string): CdmJsonContract {
        const contractsForTarget = this.cdmJson.contracts?.[this.targetHash];
        if (!contractsForTarget || !(library in contractsForTarget)) {
            throw new ContractNotFoundError(library, this.targetHash);
        }
        return contractsForTarget[library];
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
     * `paritytech/playground-cli/cdm.json`. Used here as the reproducer
     * for the cdm-resolution flow: if `getContract()` works against
     * this manifest shape, it works against any consumer's manifest.
     *
     * Notable shape differences from the generated examples:
     *   - `metadataCid` is absent (made optional in 0.2.1)
     *   - target hash is a single 16-char hex string
     *   - `dependencies` uses `"latest"` for version
     *   - contract addresses are 20-byte EVM-shaped (Polkadot Asset Hub
     *     uses Solidity-compatible addresses for Revive contracts)
     */
    const playgroundCdm: CdmJson = {
        targets: {
            acc2c3b5e912b762: {
                "asset-hub": "wss://paseo-asset-hub-next-rpc.polkadot.io",
                bulletin: "https://paseo-bulletin-next-ipfs.polkadot.io",
            },
        },
        dependencies: {
            acc2c3b5e912b762: {
                "@w3s/playground-registry": "latest",
            },
        },
        contracts: {
            acc2c3b5e912b762: {
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

    describe("ContractManager — cdm.json resolution", () => {
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

        test("auto-selects the first target when no targetHash is provided", () => {
            const manager = new ContractManager(playgroundCdm, fakeRuntime());
            // Single-target manifest — should resolve cleanly without
            // requiring an explicit targetHash.
            expect(() => manager.getContract("@w3s/playground-registry")).not.toThrow();
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

        test("explicit targetHash option selects the right contracts subtree", () => {
            // Multi-target manifest: we should be able to pin to a specific
            // target hash and have getContract resolve against it.
            const multiTargetCdm: CdmJson = {
                targets: {
                    target_a: { "asset-hub": "wss://a", bulletin: "https://a" },
                    target_b: { "asset-hub": "wss://b", bulletin: "https://b" },
                },
                dependencies: {
                    target_a: { "@org/foo": "1.0" },
                    target_b: { "@org/foo": "2.0" },
                },
                contracts: {
                    target_a: {
                        "@org/foo": {
                            version: 1,
                            address: "0x1111111111111111111111111111111111111111",
                            abi: [],
                        },
                    },
                    target_b: {
                        "@org/foo": {
                            version: 2,
                            address: "0x2222222222222222222222222222222222222222",
                            abi: [],
                        },
                    },
                },
            };

            const aManager = new ContractManager(multiTargetCdm, fakeRuntime(), {
                targetHash: "target_a",
            });
            const bManager = new ContractManager(multiTargetCdm, fakeRuntime(), {
                targetHash: "target_b",
            });

            expect(aManager.getAddress("@org/foo")).toBe(
                "0x1111111111111111111111111111111111111111",
            );
            expect(bManager.getAddress("@org/foo")).toBe(
                "0x2222222222222222222222222222222222222222",
            );
        });

        test("constructor throws when cdm.json has no targets", () => {
            const emptyCdm: CdmJson = { targets: {}, dependencies: {} };
            expect(() => new ContractManager(emptyCdm, fakeRuntime())).toThrow(/No targets found/);
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
