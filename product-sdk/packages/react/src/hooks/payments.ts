// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { UseQueryResult } from "@tanstack/react-query";
import {
    type PaymentBalance,
    type PaymentPurseId,
    type PaymentStatus,
    type PaymentTopUpSource,
    queryKeys,
    toKeyPart,
} from "@parity/product-sdk-hooks-core";
import { useCallback } from "react";
import { useRuntime } from "../context.js";
import {
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    dropMutate,
    useLiveQuery,
    useTruapiMutation,
} from "../internal.js";

/** Live RFC-0006 payment balance (host-only; errors standalone). */
export function usePaymentBalance(options?: {
    purse?: PaymentPurseId;
    enabled?: boolean;
    query?: QueryOptions<PaymentBalance>;
}): UseQueryResult<PaymentBalance, Error> {
    const runtime = useRuntime();
    return useLiveQuery<PaymentBalance>({
        queryKey: queryKeys.paymentBalance(toKeyPart(options?.purse)),
        attach: (onValue, onError) =>
            runtime.payments.watchBalance(onValue, {
                ...(options?.purse !== undefined ? { purse: options.purse } : {}),
                onError,
            }),
        enabled: options?.enabled ?? true,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

export interface RequestPaymentVariables {
    amount: bigint;
    destination: `0x${string}`;
    from?: PaymentPurseId;
}

/** Request a payment from the user — the host shows the confirmation UI: `request(amount, destination)`. */
export function useRequestPayment(options?: {
    mutation?: MutationOptions<{ id: string }, RequestPaymentVariables>;
}): NamedMutation<{ id: string }, RequestPaymentVariables> & {
    request: (
        amount: bigint,
        destination: `0x${string}`,
        from?: PaymentPurseId,
    ) => Promise<{ id: string }>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ amount, destination, from }: RequestPaymentVariables) =>
            runtime.payments.request(amount, destination, from),
        options?.mutation,
    );
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        request: useCallback(
            (amount: bigint, destination: `0x${string}`, from?: PaymentPurseId) =>
                mutateAsync({ amount, destination, ...(from !== undefined ? { from } : {}) }),
            [mutateAsync],
        ),
    };
}

export interface TopUpVariables {
    amount: bigint;
    source: PaymentTopUpSource;
    into?: PaymentPurseId;
}

/** Top up the payment balance from a product account or provided keys: `topUp(amount, source)`. */
export function useTopUp(options?: {
    mutation?: MutationOptions<void, TopUpVariables>;
}): NamedMutation<void, TopUpVariables> & {
    topUp: (amount: bigint, source: PaymentTopUpSource, into?: PaymentPurseId) => Promise<void>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ amount, source, into }: TopUpVariables) => runtime.payments.topUp(amount, source, into),
        options?.mutation,
    );
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        topUp: useCallback(
            (amount: bigint, source: PaymentTopUpSource, into?: PaymentPurseId) =>
                mutateAsync({ amount, source, ...(into !== undefined ? { into } : {}) }),
            [mutateAsync],
        ),
    };
}

/** Track a payment to its terminal state (Processing → Completed | Failed). */
export function usePaymentStatus(
    paymentId: string | undefined,
    options?: { query?: QueryOptions<PaymentStatus> },
): UseQueryResult<PaymentStatus, Error> {
    const runtime = useRuntime();
    return useLiveQuery<PaymentStatus>({
        queryKey: queryKeys.paymentStatus(paymentId ?? ""),
        attach: (onValue, onError) =>
            runtime.payments.watchStatus(paymentId ?? "", onValue, { onError }),
        enabled: paymentId !== undefined,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}
