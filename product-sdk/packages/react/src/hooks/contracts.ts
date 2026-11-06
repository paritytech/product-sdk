// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { UseQueryResult } from "@tanstack/react-query";
import {
    type AbiEntry,
    type CdmJson,
    type Contract,
    type ContractDef,
    type TxResult,
    queryKeys,
    resolveChain,
    unwrapResult,
} from "@parity/product-sdk-hooks-core";
import { useCallback } from "react";
import { type ChainKey, useRuntime } from "../context.js";
import {
    type MutationOptions,
    type NamedMutation,
    type OptionalVariables,
    type QueryOptions,
    dropMutate,
    useTruapiMutation,
    useTruapiQuery,
} from "../internal.js";

export interface ContractScope<K extends ChainKey = ChainKey> {
    chain?: K;
    /** Resolve addresses from the live CDM registry instead of the manifest snapshot. */
    live?: boolean;
}

// Query keys need a serializable identity for manifests and contract handles;
// a per-object id is stable for the session, which is all a cache key needs.
const weakIds = new WeakMap<object, number>();
let nextWeakId = 1;
function weakId(value: object): string {
    let id = weakIds.get(value);
    if (id === undefined) {
        id = nextWeakId++;
        weakIds.set(value, id);
    }
    return `#${id}`;
}

function manifestKey(cdmJson: CdmJson): string {
    const name = (cdmJson as { name?: unknown }).name;
    return typeof name === "string" ? name : weakId(cdmJson);
}

/**
 * Typed contract handle from a `cdm.json` manifest. Managers are cached per
 * (chain, manifest) and share the runtime's SignerManager.
 */
export function useContract(
    cdmJson: CdmJson,
    library: string,
    options?: ContractScope & { query?: QueryOptions<Contract<ContractDef>> },
): UseQueryResult<Contract<ContractDef>, Error> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useTruapiQuery(
        queryKeys.contract(chainKey, manifestKey(cdmJson), library, options?.live ?? false),
        () => runtime.contracts.getContract(cdmJson, library, options),
        options,
    );
}

/** Ad-hoc contract from an H160 address + ABI — no manifest needed. */
export function useContractAt(
    address: `0x${string}` | undefined,
    abi: AbiEntry[],
    options?: { chain?: ChainKey; query?: QueryOptions<Contract<ContractDef>> },
): UseQueryResult<Contract<ContractDef>, Error> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useTruapiQuery(
        queryKeys.contractAt(chainKey, address ?? null),
        async () => {
            if (!address) throw new Error("product-sdk: useContractAt needs an address");
            return runtime.contracts.getContractAt(address, abi, options);
        },
        { ...options, enabled: address !== undefined },
    );
}

/**
 * Read-only contract call (`ReviveApi.call` dry-run) — cached under the
 * contract identity, method and args.
 *
 * ```ts
 * const count = useContractQuery(contract, "getCount", []);
 * ```
 */
export function useContractQuery<T = unknown>(
    contract: Contract<ContractDef> | undefined,
    method: string,
    args: readonly unknown[],
    options?: { enabled?: boolean; query?: QueryOptions<T> },
): UseQueryResult<T, Error> {
    return useTruapiQuery<T>(
        queryKeys.contractQuery(contract ? weakId(contract) : null, method, args),
        async () => {
            if (!contract) throw new Error("product-sdk: contract not ready");
            const handle = (
                contract as Record<string, { query: (...a: unknown[]) => Promise<unknown> }>
            )[method];
            if (!handle) throw new Error(`product-sdk: contract has no method "${method}"`);
            const result = (await handle.query(...args)) as { success: boolean; value: unknown };
            if (!result.success) {
                throw new Error(`product-sdk: contract query "${method}" reverted`, {
                    cause: result.value,
                });
            }
            // pallet-revive answers a call to an address without code with an empty
            // return, which decodes to undefined — most often the contract was wiped
            // by a chain reset. Name that instead of TanStack's "data is undefined".
            if (result.value === undefined) {
                throw new Error(
                    `product-sdk: contract query "${method}" returned no data — is the contract deployed at this address on this chain?`,
                );
            }
            return result.value as T;
        },
        { ...options, enabled: contract !== undefined && (options?.enabled ?? true) },
    );
}

/**
 * Contract transaction: dry-run pre-flight, then sign/submit/watch.
 *
 * ```ts
 * const increment = useContractTx(contract, "increment");
 * await increment.send();
 * ```
 */
export function useContractTx(
    contract: Contract<ContractDef> | undefined,
    method: string,
    options?: { mutation?: MutationOptions<TxResult, OptionalVariables<readonly unknown[]>> },
): NamedMutation<TxResult, OptionalVariables<readonly unknown[]>> & {
    send: (args?: readonly unknown[]) => Promise<TxResult>;
} {
    const mutation = useTruapiMutation(async (args: OptionalVariables<readonly unknown[]>) => {
        if (!contract) throw new Error("product-sdk: contract not ready");
        const handle = (
            contract as Record<
                string,
                {
                    tx: (
                        ...a: unknown[]
                    ) => Promise<{ ok: true; value: TxResult } | { ok: false; error: Error }>;
                }
            >
        )[method];
        if (!handle) throw new Error(`product-sdk: contract has no method "${method}"`);
        // Pre-flight and submission failures ride the Result err channel
        // (ContractError | TxError); a dispatch failure stays data on TxResult.ok.
        return unwrapResult(await handle.tx(...(args ?? [])));
    }, options?.mutation);
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        send: useCallback((args?: readonly unknown[]) => mutateAsync(args), [mutateAsync]),
    };
}

/** Idempotent pallet-revive account mapping — required once before contract txs: `ensureMapped()`. */
export function useEnsureAccountMapped(
    cdmJson: CdmJson,
    options?: { chain?: ChainKey; mutation?: MutationOptions<void, void> },
): NamedMutation<void, void> & {
    ensureMapped: () => Promise<void>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        () => runtime.contracts.ensureMapped(cdmJson, options),
        options?.mutation,
    );
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        ensureMapped: useCallback(() => mutateAsync(), [mutateAsync]),
    };
}
