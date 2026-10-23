// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type {
    AnyBatchCall,
    AnyTx,
    BatchMode,
    SubmitOptions,
    TxPhase,
    TxResult,
    TypedApiOf,
} from "@parity/product-sdk-hooks-core";
import { useCallback, useState } from "react";
import { type ChainKey, type ResolvedChains, useRuntime } from "../context.js";
import {
    type MutationOptions,
    type NamedMutation,
    dropMutate,
    useTruapiMutation,
} from "../internal.js";

export interface TxVariables<K extends ChainKey, TBuild, TOptions> {
    build: (api: TypedApiOf<ResolvedChains, K>) => TBuild | Promise<TBuild>;
    options?: TOptions;
}

export interface UseTxResult<K extends ChainKey>
    extends Omit<NamedMutation<TxResult, TxVariables<K, AnyTx, SubmitOptions>>, "reset"> {
    /**
     * Build against the typed api and submit; resolves when the tx reaches
     * best-block (or `waitFor: "finalized"`).
     */
    submit: (
        build: (api: TypedApiOf<ResolvedChains, K>) => AnyTx | Promise<AnyTx>,
        options?: SubmitOptions,
    ) => Promise<TxResult>;
    /** "idle" → "signing" → "broadcasting" → "in-block" → "finalized" | "error". */
    phase: TxPhase;
    reset: () => void;
}

/**
 * Transaction lifecycle as a TanStack mutation with a granular `phase`.
 * Permission (`ChainSubmit`) and signer connection are handled automatically
 * on first submit.
 *
 * ```ts
 * const { submit, phase } = useTx();
 * await submit((api) => api.tx.Balances.transfer_keep_alive({ dest, value }));
 * ```
 */
export function useTx<K extends ChainKey = ChainKey>(options?: {
    chain?: K;
    mutation?: MutationOptions<TxResult, TxVariables<K, AnyTx, SubmitOptions>>;
}): UseTxResult<K> {
    const runtime = useRuntime();
    const [phase, setPhase] = useState<TxPhase>("idle");
    const chain = options?.chain;

    const mutation = useTruapiMutation<TxVariables<K, AnyTx, SubmitOptions>, TxResult>(
        async ({ build, options: submitOptions }) => {
            setPhase("signing");
            try {
                const txResult = await runtime.tx.submit(build as never, {
                    ...submitOptions,
                    ...(chain !== undefined ? { chain } : {}),
                    onStatus: (status) => {
                        setPhase(status);
                        submitOptions?.onStatus?.(status);
                    },
                });
                setPhase(
                    txResult.ok
                        ? submitOptions?.waitFor === "finalized"
                            ? "finalized"
                            : "in-block"
                        : "error",
                );
                return txResult;
            } catch (e) {
                setPhase("error");
                throw e;
            }
        },
        options?.mutation,
    );

    const { mutateAsync, reset: resetMutation } = mutation;
    return {
        ...dropMutate(mutation),
        phase,
        submit: useCallback(
            (build, submitOptions) => mutateAsync({ build, options: submitOptions }),
            [mutateAsync],
        ),
        reset: useCallback(() => {
            resetMutation();
            setPhase("idle");
        }, [resetMutation]),
    };
}

export interface UseBatchTxResult<K extends ChainKey>
    extends Omit<
        NamedMutation<
            TxResult,
            TxVariables<K, AnyBatchCall[], SubmitOptions & { mode?: BatchMode }>
        >,
        "reset"
    > {
    submit: (
        build: (api: TypedApiOf<ResolvedChains, K>) => AnyBatchCall[] | Promise<AnyBatchCall[]>,
        options?: SubmitOptions & { mode?: BatchMode },
    ) => Promise<TxResult>;
    phase: TxPhase;
    reset: () => void;
}

/** Like `useTx` but wraps the built calls in `Utility.batch_all` (atomic by default). */
export function useBatchTx<K extends ChainKey = ChainKey>(options?: {
    chain?: K;
    mutation?: MutationOptions<
        TxResult,
        TxVariables<K, AnyBatchCall[], SubmitOptions & { mode?: BatchMode }>
    >;
}): UseBatchTxResult<K> {
    const runtime = useRuntime();
    const [phase, setPhase] = useState<TxPhase>("idle");
    const chain = options?.chain;

    const mutation = useTruapiMutation<
        TxVariables<K, AnyBatchCall[], SubmitOptions & { mode?: BatchMode }>,
        TxResult
    >(async ({ build, options: submitOptions }) => {
        setPhase("signing");
        try {
            const txResult = await runtime.tx.submitBatch(build as never, {
                ...submitOptions,
                ...(chain !== undefined ? { chain } : {}),
                onStatus: (status) => {
                    setPhase(status);
                    submitOptions?.onStatus?.(status);
                },
            });
            setPhase(
                txResult.ok
                    ? submitOptions?.waitFor === "finalized"
                        ? "finalized"
                        : "in-block"
                    : "error",
            );
            return txResult;
        } catch (e) {
            setPhase("error");
            throw e;
        }
    }, options?.mutation);

    const { mutateAsync, reset: resetMutation } = mutation;
    return {
        ...dropMutate(mutation),
        phase,
        submit: useCallback(
            (build, submitOptions) => mutateAsync({ build, options: submitOptions }),
            [mutateAsync],
        ),
        reset: useCallback(() => {
            resetMutation();
            setPhase("idle");
        }, [resetMutation]),
    };
}
