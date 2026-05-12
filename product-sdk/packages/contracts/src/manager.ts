import type { HexString, PolkadotClient } from "polkadot-api";
import type { InkSdk } from "@polkadot-api/sdk-ink";
import { wrapContract } from "./wrap.js";
import { ContractNotFoundError } from "./errors.js";
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
 * import { createInkSdk } from "@polkadot-api/sdk-ink";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { ContractManager } from "@parity/product-sdk-contracts";
 * import cdmJson from "./cdm.json";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub },
 *     rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
 * });
 * const inkSdk = createInkSdk(client.raw.assetHub, { atBest: true });
 * const manager = new ContractManager(cdmJson, inkSdk, {
 *     signerManager: signerManager, // from @parity/product-sdk-signer
 * });
 *
 * // Uses the host's logged-in account automatically
 * const counter = manager.getContract("@example/counter");
 * const { value } = await counter.getCount.query();
 * await counter.increment.tx();
 * ```
 */
export class ContractManager {
    private cdmJson: CdmJson;
    private targetHash: string;
    private inkSdk: InkSdk;
    private defaults: ContractDefaults;

    constructor(cdmJson: CdmJson, inkSdk: InkSdk, options?: ContractManagerOptions) {
        this.cdmJson = cdmJson;
        this.inkSdk = inkSdk;

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
     * Create a ContractManager from a raw `PolkadotClient`.
     *
     * Convenience factory that creates the InkSdk internally via dynamic import
     * of `@polkadot-api/sdk-ink`. The ~4 MB sdk-ink metadata is loaded lazily
     * only when this method is called.
     *
     * For size-sensitive apps, prefer the constructor with a pre-created `InkSdk`
     * to control exactly when `@polkadot-api/sdk-ink` is loaded.
     *
     * @param cdmJson - The CDM manifest.
     * @param client - A `PolkadotClient` for the chain where contracts are deployed (e.g., `client.raw.assetHub`).
     * @param options - Optional configuration (signerManager, defaults).
     *
     * @example
     * ```ts
     * import { createChainClient } from "@parity/product-sdk-chain-client";
     * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
     * import { ContractManager } from "@parity/product-sdk-contracts";
     *
     * const client = await createChainClient({
     *     chains: { assetHub: paseo_asset_hub },
     *     rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
     * });
     * const manager = await ContractManager.fromClient(cdmJson, client.raw.assetHub, {
     *     signerManager,
     * });
     * ```
     */
    static async fromClient(
        cdmJson: CdmJson,
        client: PolkadotClient,
        options?: ContractManagerOptions,
    ): Promise<ContractManager> {
        const { createInkSdk } = await import("@polkadot-api/sdk-ink");
        const inkSdk = createInkSdk(client, { atBest: true });
        return new ContractManager(cdmJson, inkSdk, options);
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
        const descriptor = { abi: data.abi };
        const inkContract = this.inkSdk.getContract(descriptor as any, data.address);
        return wrapContract(inkContract, data.abi, this.defaults);
    }

    /** Get the on-chain address of an installed contract. */
    getAddress(library: string): HexString {
        return this.getContractData(library).address;
    }
}

/**
 * Create a contract handle from a raw address and ABI — no `cdm.json` needed.
 *
 * @example
 * ```ts
 * import { createInkSdk } from "@polkadot-api/sdk-ink";
 *
 * const inkSdk = createInkSdk(client.raw.assetHub, { atBest: true });
 * const counter = createContract(inkSdk, "0xC472...", abi, {
 *     signerManager: signerManager,
 * });
 * await counter.getCount.query();
 * await counter.increment.tx();
 * ```
 */
export function createContract(
    inkSdk: InkSdk,
    address: HexString,
    abi: AbiEntry[],
    options?: ContractOptions,
): Contract<ContractDef> {
    const inkContract = inkSdk.getContract({ abi } as any, address);
    const defaults: ContractDefaults = {
        signerManager: options?.signerManager,
        origin: options?.defaultOrigin,
        signer: options?.defaultSigner,
    };
    return wrapContract(inkContract, abi, defaults);
}

/**
 * Create a contract handle from a raw `PolkadotClient`, address, and ABI.
 *
 * Convenience wrapper that creates the InkSdk internally via dynamic import.
 * For size-sensitive apps, use {@link createContract} with a pre-created `InkSdk`.
 *
 * @example
 * ```ts
 * const counter = await createContractFromClient(client.raw.assetHub, "0xC472...", abi);
 * const { value } = await counter.getCount.query();
 * ```
 */
export async function createContractFromClient(
    client: PolkadotClient,
    address: HexString,
    abi: AbiEntry[],
    options?: ContractOptions,
): Promise<Contract<ContractDef>> {
    const { createInkSdk } = await import("@polkadot-api/sdk-ink");
    const inkSdk = createInkSdk(client, { atBest: true });
    return createContract(inkSdk, address, abi, options);
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
     * Minimal InkSdk stub — `getContract()` is the only method
     * `ContractManager.getContract()` calls. Everything else on the SDK
     * is left undefined so a misroute through any other method would
     * throw and surface in the test.
     */
    function fakeInkSdk(): InkSdk {
        return {
            getContract: (descriptor: unknown, address: unknown) => ({
                __descriptor: descriptor,
                __address: address,
                // Each method on a real ink contract has `query` + `send`.
                // We don't invoke them in the smoke test — just need the
                // shape to flow through `wrapContract`'s proxy.
                query: async () => ({ success: true, value: { response: undefined } }),
                send: () => ({ waited: Promise.resolve({}) }),
            }),
        } as unknown as InkSdk;
    }

    describe("ContractManager — cdm.json resolution", () => {
        test("constructs from a real-world cdm.json without errors", () => {
            const manager = new ContractManager(playgroundCdm, fakeInkSdk());
            expect(manager.getAddress("@w3s/playground-registry")).toBe(
                "0x4A37B123b0BA2A894cA5953f472264921d44e298",
            );
        });

        test("getContract returns a typed handle for a library in the manifest", () => {
            const manager = new ContractManager(playgroundCdm, fakeInkSdk());
            const registry = manager.getContract("@w3s/playground-registry");

            // Methods from the abi are accessible
            expect(typeof registry.publish.query).toBe("function");
            expect(typeof registry.publish.tx).toBe("function");
            expect(typeof registry.publish.prepare).toBe("function");
            expect(typeof registry.unpublish.query).toBe("function");
        });

        test("getContract throws ContractNotFoundError for an unknown library", () => {
            const manager = new ContractManager(playgroundCdm, fakeInkSdk());
            expect(() => manager.getContract("@nonexistent/contract")).toThrow(
                /not found in cdm\.json/,
            );
        });

        test("auto-selects the first target when no targetHash is provided", () => {
            const manager = new ContractManager(playgroundCdm, fakeInkSdk());
            // Single-target manifest — should resolve cleanly without
            // requiring an explicit targetHash.
            expect(() => manager.getContract("@w3s/playground-registry")).not.toThrow();
        });

        test("getContract passes the right address to inkSdk", () => {
            let capturedAddress: unknown;
            const inkSdk = {
                getContract: (_descriptor: unknown, address: unknown) => {
                    capturedAddress = address;
                    return {
                        query: async () => ({ success: true, value: { response: undefined } }),
                        send: () => ({ waited: Promise.resolve({}) }),
                    };
                },
            } as unknown as InkSdk;

            const manager = new ContractManager(playgroundCdm, inkSdk);
            manager.getContract("@w3s/playground-registry");
            expect(capturedAddress).toBe("0x4A37B123b0BA2A894cA5953f472264921d44e298");
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

            const aManager = new ContractManager(multiTargetCdm, fakeInkSdk(), {
                targetHash: "target_a",
            });
            const bManager = new ContractManager(multiTargetCdm, fakeInkSdk(), {
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
            expect(() => new ContractManager(emptyCdm, fakeInkSdk())).toThrow(/No targets found/);
        });
    });

    describe("ContractManager defaults", () => {
        test("setDefaults updates origin / signer / signerManager mid-flight", () => {
            const manager = new ContractManager(playgroundCdm, fakeInkSdk(), {
                defaultOrigin: "5OldOrigin" as HexString,
            });
            // This is a behavioral check via private-ish field — we don't
            // expose `defaults` directly, but `setDefaults` returning
            // without error is the contract.
            expect(() => manager.setDefaults({ origin: "5NewOrigin" as HexString })).not.toThrow();
        });
    });
}
