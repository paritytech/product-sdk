// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type BatchMode,
    type SubmitOptions,
    type TxResult,
    type TxStatus,
    batchSubmitAndWatch,
    submitAndWatch,
} from "@parity/product-sdk-tx";
import type { AccountsController } from "./accounts.js";
import type { ChainController, TypedApiOf } from "./chain.js";
import type { AnyChains } from "./config.js";
import { unwrapResult } from "./host.js";

export type { BatchMode, SubmitOptions, TxResult, TxStatus };

export type AnyTx = Parameters<typeof submitAndWatch>[0];
export type AnyBatchCall = Parameters<typeof batchSubmitAndWatch>[0][number];

/** UI-facing lifecycle: "idle" before the first submit, then the SDK's TxStatus. */
export type TxPhase = "idle" | TxStatus;

export interface TxController<TChains extends AnyChains> {
    /**
     * Ensure permission + signer (connecting on demand), build the transaction
     * against the chain's typed api, then sign, submit and watch.
     */
    submit<K extends keyof TChains & string>(
        build: (api: TypedApiOf<TChains, K>) => AnyTx | Promise<AnyTx>,
        options?: SubmitOptions & { chain?: K },
    ): Promise<TxResult>;
    /** Same flow but wraps the calls in `Utility.batch_all` (or the given mode). */
    submitBatch<K extends keyof TChains & string>(
        build: (api: TypedApiOf<TChains, K>) => AnyBatchCall[] | Promise<AnyBatchCall[]>,
        options?: SubmitOptions & { chain?: K; mode?: BatchMode },
    ): Promise<TxResult>;
}

export function createTxController<TChains extends AnyChains>(
    chains: ChainController<TChains>,
    accounts: AccountsController,
): TxController<TChains> {
    const acquireSigner = async () => {
        await accounts.ensureChainSubmitPermission();
        let signer = accounts.getSigner();
        if (!signer) {
            await accounts.connect();
            signer = accounts.getSigner();
        }
        if (!signer) throw new Error("product-sdk: no signer available — is an account connected?");
        return signer;
    };

    return {
        submit: async (build, options) => {
            const [signer, api] = await Promise.all([
                acquireSigner(),
                chains.getTypedApi(options?.chain),
            ]);
            const tx = await build(api);
            // The SDK reports signing/submission failures on the Result err channel
            // (TxSigningRejectedError, TxValidityError, …); dispatch failures stay
            // data on TxResult.ok. Throw the former so hooks surface them as `error`.
            return unwrapResult(await submitAndWatch(tx, signer, options));
        },
        submitBatch: async (build, options) => {
            const [signer, api] = await Promise.all([
                acquireSigner(),
                chains.getTypedApi(options?.chain),
            ]);
            const calls = await build(api);
            return unwrapResult(
                await batchSubmitAndWatch(
                    calls,
                    api as unknown as Parameters<typeof batchSubmitAndWatch>[1],
                    signer,
                    options,
                ),
            );
        },
    };
}
