// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type AbiEntry,
    type CdmJson,
    type Contract,
    type ContractDef,
    ContractManager,
    createContractFromClient,
    ensureContractAccountMapped,
} from "@parity/product-sdk-contracts";
import type { AccountsController } from "./accounts.js";
import type { ChainController } from "./chain.js";
import type { AnyChains } from "./config.js";
import { type TruapiConfig, resolveChain } from "./config.js";
import { unwrapResult } from "./host.js";

export type { AbiEntry, CdmJson, Contract, ContractDef };

export interface ContractsController<TChains extends AnyChains> {
    /** Manager per (chain, manifest), cached; wired to the runtime's SignerManager. */
    getManager(
        cdmJson: CdmJson,
        options?: { chain?: keyof TChains & string; live?: boolean },
    ): Promise<ContractManager>;
    getContract(
        cdmJson: CdmJson,
        library: string,
        options?: { chain?: keyof TChains & string; live?: boolean },
    ): Promise<Contract<ContractDef>>;
    /** Ad-hoc contract from address + ABI, no cdm.json manifest. */
    getContractAt(
        address: `0x${string}`,
        abi: AbiEntry[],
        options?: { chain?: keyof TChains & string },
    ): Promise<Contract<ContractDef>>;
    /**
     * Register the account → H160 mapping on pallet-revive (idempotent);
     * required once per account before EVM contract transactions.
     */
    ensureMapped(cdmJson: CdmJson, options?: { chain?: keyof TChains & string }): Promise<void>;
}

export function createContractsController<TChains extends AnyChains>(
    config: TruapiConfig<TChains>,
    chains: ChainController<TChains>,
    accounts: AccountsController,
): ContractsController<TChains> {
    const managers = new Map<string, WeakMap<CdmJson, Promise<ContractManager>>>();

    const getManager: ContractsController<TChains>["getManager"] = (cdmJson, options) => {
        const { key, chain } = resolveChain(config, options?.chain);
        const cacheKey = `${key}:${options?.live ? "live" : "snapshot"}`;
        let byManifest = managers.get(cacheKey);
        if (!byManifest) {
            byManifest = new WeakMap();
            managers.set(cacheKey, byManifest);
        }
        let manager = byManifest.get(cdmJson);
        if (!manager) {
            manager = (async () => {
                const client = await chains.getClient(options?.chain);
                const managerOptions = { signerManager: accounts.manager };
                if (options?.live) {
                    // Live registry resolution fails on the Result err channel
                    // (ContractLiveAddressResolutionError / ContractNotFoundError).
                    return unwrapResult(
                        await ContractManager.fromLiveClient(
                            cdmJson,
                            client,
                            chain.descriptor,
                            managerOptions,
                        ),
                    );
                }
                return ContractManager.fromClient(
                    cdmJson,
                    client,
                    chain.descriptor,
                    managerOptions,
                );
            })();
            manager.catch(() => byManifest?.delete(cdmJson));
            byManifest.set(cdmJson, manager);
        }
        return manager;
    };

    return {
        getManager,
        getContract: async (cdmJson, library, options) =>
            (await getManager(cdmJson, options)).getContract(library),
        getContractAt: async (address, abi, options) => {
            const { chain } = resolveChain(config, options?.chain);
            const client = await chains.getClient(options?.chain);
            return createContractFromClient(client, chain.descriptor, address, abi, {
                signerManager: accounts.manager,
            });
        },
        ensureMapped: async (cdmJson, options) => {
            const manager = await getManager(cdmJson, options);
            await accounts.connect();
            const account = accounts.state.get().selectedAccount;
            const signer = accounts.getSigner();
            if (!account || !signer) {
                throw new Error("product-sdk: connect an account before mapping it for contracts");
            }
            // ok(null) means the account was already mapped; err carries the TxError.
            unwrapResult(
                await ensureContractAccountMapped(manager.getRuntime(), account.address, signer),
            );
        },
    };
}
