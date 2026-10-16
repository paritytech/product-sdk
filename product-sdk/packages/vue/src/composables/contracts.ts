// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
import { type ChainKey, useRuntime } from "../context.js";
import {
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type OptionalVariables,
    type QueryOptions,
    type QueryResult,
    dropMutate,
    toGetter,
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
): QueryResult<Contract<ContractDef>> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    return useTruapiQuery(
        () => queryKeys.contract(chainKey, manifestKey(cdmJson), library, options?.live ?? false),
        () => runtime.contracts.getContract(cdmJson, library, options),
        options,
    );
}

/** Ad-hoc contract from an H160 address + ABI — no manifest needed. */
export function useContractAt(
    address: MaybeGetter<`0x${string}` | undefined>,
    abi: AbiEntry[],
    options?: { chain?: ChainKey; query?: QueryOptions<Contract<ContractDef>> },
): QueryResult<Contract<ContractDef>> {
    const runtime = useRuntime();
    const chainKey = resolveChain(runtime.config, options?.chain).key;
    const getAddress = toGetter(address);
    return useTruapiQuery(
        () => queryKeys.contractAt(chainKey, getAddress() ?? null),
        async () => {
            const resolved = getAddress();
            if (!resolved) throw new Error("product-sdk: useContractAt needs an address");
            return runtime.contracts.getContractAt(resolved, abi, options);
        },
        { ...options, enabled: () => getAddress() !== undefined },
    );
}

/**
 * Read-only contract call (`ReviveApi.call` dry-run) — cached under the
 * contract identity, method and args; reactive args re-run it.
 */
export function useContractQuery<T = unknown>(
    contract: QueryResult<Contract<ContractDef>>,
    method: string,
    args: MaybeGetter<readonly unknown[]> = [],
    options?: { enabled?: MaybeGetter<boolean>; query?: QueryOptions<T> },
): QueryResult<T> {
    const getArgs = toGetter(args);
    const enabled = toGetter(options?.enabled ?? true);
    return useTruapiQuery<T>(
        () =>
            queryKeys.contractQuery(
                contract.data.value ? weakId(contract.data.value) : null,
                method,
                getArgs(),
            ),
        async () => {
            const handleSource = contract.data.value;
            if (!handleSource) throw new Error("product-sdk: contract not ready");
            const handle = (
                handleSource as Record<string, { query: (...a: unknown[]) => Promise<unknown> }>
            )[method];
            if (!handle) throw new Error(`product-sdk: contract has no method "${method}"`);
            const result = (await handle.query(...getArgs())) as {
                success: boolean;
                value: unknown;
            };
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
        {
            ...options,
            enabled: () => contract.data.value !== undefined && enabled() !== false,
        },
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
    contract: QueryResult<Contract<ContractDef>>,
    method: string,
    options?: { mutation?: MutationOptions<TxResult, OptionalVariables<readonly unknown[]>> },
): NamedMutation<TxResult, OptionalVariables<readonly unknown[]>> & {
    send: (args?: readonly unknown[]) => Promise<TxResult>;
} {
    const mutation = useTruapiMutation(async (args: OptionalVariables<readonly unknown[]>) => {
        const handleSource = contract.data.value;
        if (!handleSource) throw new Error("product-sdk: contract not ready");
        const handle = (
            handleSource as Record<
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
    return {
        ...dropMutate(mutation),
        send: (args?: readonly unknown[]) => mutation.mutateAsync(args),
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
    return {
        ...dropMutate(mutation),
        ensureMapped: () => mutation.mutateAsync(),
    };
}
