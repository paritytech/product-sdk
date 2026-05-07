import type { SS58String, PolkadotSigner } from "polkadot-api";
import { type Binary, FixedSizeBinary } from "@polkadot-api/substrate-bindings";
import type { SubmittableTransaction, Weight, TxResult } from "@parity/product-sdk-tx";
import { ensureAccountMapped } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";

/**
 * Result of a `Revive.call` extrinsic — present on the typed API as
 * `api.tx.Revive.call(args)`. Returned object is a PAPI submittable that
 * `submitAndWatch` consumes natively.
 */
export type ReviveCallTx = (args: {
    dest: FixedSizeBinary<20>;
    value: bigint;
    weight_limit: Weight;
    storage_deposit_limit: bigint;
    data: Binary;
}) => SubmittableTransaction;

/**
 * Dry-run result returned by `ReviveApi.call`. Mirrors the shape exposed by
 * descriptors (`paseo-asset-hub`, `polkadot-asset-hub`, `kusama-asset-hub`).
 */
export interface ReviveDryRunResult {
    weight_consumed: Weight;
    weight_required: Weight;
    storage_deposit: { type: "Refund" | "Charge"; value: bigint };
    max_storage_deposit: { type: "Refund" | "Charge"; value: bigint };
    gas_consumed: bigint;
    /**
     * `success: true` carries `{ flags, data }`; `success: false` carries the
     * dispatch error as the chain encoded it.
     */
    result:
        | { success: true; value: { flags: number; data: Binary } }
        | { success: false; value: unknown };
}

/** Structural shape consumed by `ContractManager` / `createContract`. */
export interface ReviveTypedApi {
    tx: {
        Revive: {
            call: ReviveCallTx;
            map_account(): SubmittableTransaction;
        };
    };
    query: {
        Revive: {
            OriginalAccount: {
                getValue(address: FixedSizeBinary<20>): Promise<SS58String | undefined>;
            };
        };
    };
    apis: {
        ReviveApi: {
            call(
                origin: SS58String,
                dest: FixedSizeBinary<20>,
                value: bigint,
                gas_limit: Weight | undefined,
                storage_deposit_limit: bigint | undefined,
                input_data: Binary,
            ): Promise<ReviveDryRunResult>;
        };
    };
}

/**
 * Runtime handle that drives queries and transactions against a
 * pallet-revive-capable chain.
 *
 * @example
 * ```ts
 * import { createChainClient } from "@parity/product-sdk-chain-client";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { createContractRuntime } from "@parity/product-sdk-contracts";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub },
 *     rpcs: { assetHub: ["wss://sys.ibp.network/asset-hub-paseo"] },
 * });
 * const runtime = createContractRuntime(client.assetHub);
 * ```
 */
export interface ContractRuntime {
    readonly api: ReviveTypedApi;
}

/**
 * Wrap a typed PAPI API as a `ContractRuntime`. The argument is accepted
 * structurally; any chain whose typed API exposes `tx.Revive.call` and
 * `apis.ReviveApi.call` works.
 */
export function createContractRuntime(api: ReviveTypedApi): ContractRuntime {
    return { api };
}

/**
 * Ensure the SS58 account is mapped to its derived H160 on `pallet-revive`.
 *
 * `pallet-revive` requires every signing account to have a registered
 * `OriginalAccount` mapping before the runtime accepts its `Revive.call`
 * extrinsics. The mapping is one-time and cheap. This helper:
 *
 *   1. Reads `Revive.OriginalAccount` for the H160 derived from `address`.
 *   2. Returns `null` if already mapped (idempotent fast-path).
 *   3. Otherwise submits `Revive.map_account()` and waits for inclusion.
 *
 * Call this once per signing account at app startup — after that, every
 * subsequent `contract.<method>.tx({ signer })` against the same chain will
 * succeed without further mapping work.
 *
 * @param runtime - The contract runtime (typically `createContractRuntime(...)`).
 * @param address - The SS58 address of the account to map.
 * @param signer - A signer matching `address`.
 * @param options - Optional timeout / status callback (forwarded to the underlying tx).
 * @returns The `TxResult` from the mapping extrinsic, or `null` if already mapped.
 *
 * @example
 * ```ts
 * import { createContractRuntime, ensureContractAccountMapped } from "@parity/product-sdk-contracts";
 *
 * const runtime = createContractRuntime(client.getTypedApi(paseo_asset_hub));
 * await ensureContractAccountMapped(runtime, signerManager.getState().selectedAccount!.address, signer);
 * // now safe to call contract.<method>.tx({ signer })
 * ```
 */
export async function ensureContractAccountMapped(
    runtime: ContractRuntime,
    address: SS58String,
    signer: PolkadotSigner,
    options?: { timeoutMs?: number; onStatus?: (s: string) => void },
): Promise<TxResult | null> {
    const checker = {
        addressIsMapped: async (addr: string): Promise<boolean> => {
            const h160 = ss58ToH160(addr);
            const dest = FixedSizeBinary.fromHex(h160.slice(2)) as FixedSizeBinary<20>;
            return (await runtime.api.query.Revive.OriginalAccount.getValue(dest)) !== undefined;
        },
    };
    return ensureAccountMapped(address, signer, checker, runtime.api, options);
}
