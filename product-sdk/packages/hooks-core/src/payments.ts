// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    HostUnavailableError,
    type PaymentManager,
    getPaymentManager,
} from "@parity/product-sdk-host";
import type { HostController } from "./host.js";

export type { PaymentManager };

export type PaymentBalance = Parameters<Parameters<PaymentManager["subscribeBalance"]>[0]>[0];
export type PaymentStatus = Parameters<Parameters<PaymentManager["subscribePaymentStatus"]>[1]>[0];
export type PaymentTopUpSource = Parameters<PaymentManager["topUp"]>[1];
export type PaymentPurseId = Parameters<PaymentManager["topUp"]>[2];

export interface PaymentsController {
    /** Payments are host-only (RFC-0006); resolves null standalone. */
    getManager(): Promise<PaymentManager | null>;
    watchBalance(
        onBalance: (balance: PaymentBalance) => void,
        options?: { purse?: PaymentPurseId; onError?: (error: unknown) => void },
    ): () => void;
    request(
        amount: bigint,
        destination: `0x${string}`,
        from?: PaymentPurseId,
    ): Promise<{ id: string }>;
    topUp(amount: bigint, source: PaymentTopUpSource, into?: PaymentPurseId): Promise<void>;
    watchStatus(
        paymentId: string,
        onStatus: (status: PaymentStatus) => void,
        options?: { onError?: (error: unknown) => void },
    ): () => void;
}

export function createPaymentsController(host: HostController): PaymentsController {
    let managerPromise: Promise<PaymentManager | null> | null = null;

    const getManager = (): Promise<PaymentManager | null> => {
        if (!managerPromise) {
            managerPromise = host.detect().then((inside) => (inside ? getPaymentManager() : null));
            managerPromise.catch(() => {
                managerPromise = null;
            });
        }
        return managerPromise;
    };

    const requireManager = async (): Promise<PaymentManager> => {
        const manager = await getManager();
        if (!manager) throw new HostUnavailableError("payments");
        return manager;
    };

    const watch =
        <T>(
            attach: (
                manager: PaymentManager,
                cb: (value: T) => void,
            ) => ReturnType<PaymentManager["subscribeBalance"]>,
        ) =>
        (onValue: (value: T) => void, onError?: (error: unknown) => void): (() => void) => {
            let cancelled = false;
            let teardown: (() => void) | undefined;
            void requireManager()
                .then((manager) => {
                    if (cancelled) return;
                    const sub = attach(manager, onValue);
                    const offInterrupt = sub.onInterrupt((reason) => onError?.(reason));
                    teardown = () => {
                        offInterrupt();
                        sub.unsubscribe();
                    };
                    if (cancelled) teardown();
                })
                .catch((e) => {
                    if (!cancelled) onError?.(e);
                });
            return () => {
                cancelled = true;
                teardown?.();
            };
        };

    return {
        getManager,
        watchBalance: (onBalance, options) =>
            watch<PaymentBalance>((manager, cb) => manager.subscribeBalance(cb, options?.purse))(
                onBalance,
                options?.onError,
            ),
        request: async (amount, destination, from) =>
            (await requireManager()).requestPayment(amount, destination, from),
        topUp: async (amount, source, into) => (await requireManager()).topUp(amount, source, into),
        watchStatus: (paymentId, onStatus, options) =>
            watch<PaymentStatus>((manager, cb) => manager.subscribePaymentStatus(paymentId, cb))(
                onStatus,
                options?.onError,
            ),
    };
}
