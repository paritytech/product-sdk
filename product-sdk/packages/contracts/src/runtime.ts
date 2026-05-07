import type { SS58String } from "polkadot-api";
import { type Binary, FixedSizeBinary } from "@polkadot-api/substrate-bindings";
import type { SubmittableTransaction, Weight } from "@parity/product-sdk-tx";

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
    tx: { Revive: { call: ReviveCallTx } };
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
