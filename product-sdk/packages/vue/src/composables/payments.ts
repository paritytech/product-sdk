// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type PaymentBalance,
    type PaymentPurseId,
    type PaymentStatus,
    type PaymentTopUpSource,
    queryKeys,
    toKeyPart,
} from "@parity/product-sdk-hooks-core";
import { useRuntime } from "../context.js";
import {
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    type QueryResult,
    dropMutate,
    toGetter,
    useLiveQuery,
    useTruapiMutation,
} from "../internal.js";

/** Live RFC-0006 payment balance (host-only; errors standalone). */
export function usePaymentBalance(options?: {
    purse?: PaymentPurseId;
    enabled?: MaybeGetter<boolean>;
    query?: QueryOptions<PaymentBalance>;
}): QueryResult<PaymentBalance> {
    const runtime = useRuntime();
    return useLiveQuery<PaymentBalance>({
        queryKey: () => queryKeys.paymentBalance(toKeyPart(options?.purse)),
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
    return {
        ...dropMutate(mutation),
        request: (amount: bigint, destination: `0x${string}`, from?: PaymentPurseId) =>
            mutation.mutateAsync({ amount, destination, ...(from !== undefined ? { from } : {}) }),
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
    return {
        ...dropMutate(mutation),
        topUp: (amount: bigint, source: PaymentTopUpSource, into?: PaymentPurseId) =>
            mutation.mutateAsync({ amount, source, ...(into !== undefined ? { into } : {}) }),
    };
}

/** Track a payment to its terminal state (Processing → Completed | Failed). */
export function usePaymentStatus(
    paymentId: MaybeGetter<string | undefined>,
    options?: { query?: QueryOptions<PaymentStatus> },
): QueryResult<PaymentStatus> {
    const runtime = useRuntime();
    const getId = toGetter(paymentId);
    return useLiveQuery<PaymentStatus>({
        queryKey: () => queryKeys.paymentStatus(getId() ?? ""),
        attach: (onValue, onError) =>
            runtime.payments.watchStatus(getId() ?? "", onValue, { onError }),
        enabled: () => getId() !== undefined,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}
