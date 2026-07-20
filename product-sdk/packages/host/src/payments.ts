// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's payment manager (RFC-0006), backed by
 * `truApi.payment.*`.
 *
 * Exposes balance subscription, top-up, payment requests, and payment-status
 * subscription. Distinct from the CoinPayment / merchant-payments surface
 * (RFC-0017): RFC-0006 is the user-initiated balance / top-up / payment-request
 * flow.
 *
 * @module
 */

import type {
    Balance,
    // 0.5.0 folded the purse id into the CoinPayment namespace; the RFC-0006
    // payment surface keeps the shorter local name.
    CoinPaymentPurseId as PaymentPurseId,
    HexString,
    HostPaymentBalanceSubscribeItem,
    HostPaymentStatusSubscribeItem,
    PaymentTopUpSource,
    TrUApiClient,
} from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/**
 * Payment manager handle. Exposes balance subscription, top-up, payment
 * requests, and payment-status subscription.
 *
 * The balance / status / top-up-source shapes are `@parity/truapi`'s
 * `HostPaymentBalanceSubscribeItem`, `HostPaymentStatusSubscribeItem`, and
 * `PaymentTopUpSource` — used directly rather than re-aliased.
 */
export interface PaymentManager {
    subscribeBalance(
        callback: (balance: HostPaymentBalanceSubscribeItem) => void,
        purse?: PaymentPurseId,
    ): HostSubscription;
    topUp(amount: Balance, source: PaymentTopUpSource, into?: PaymentPurseId): Promise<void>;
    requestPayment(
        amount: Balance,
        destination: HexString,
        from?: PaymentPurseId,
    ): Promise<{ id: string }>;
    subscribePaymentStatus(
        paymentId: string,
        callback: (status: HostPaymentStatusSubscribeItem) => void,
    ): HostSubscription;
}

/** Build a {@link PaymentManager} over a TruAPI client's `payment` domain. */
function adaptPaymentManager(client: TrUApiClient): PaymentManager {
    const payment = client.payment;
    return {
        subscribeBalance(callback, purse) {
            return subscribeWithInterrupt(
                payment.balanceSubscribe({ request: { purse } }),
                callback,
            );
        },
        topUp(amount, source, into) {
            return unwrapHostResult(
                payment.topUp({ into, amount, source }),
                "payment topUp failed",
            );
        },
        async requestPayment(amount, destination, from) {
            const response = await unwrapHostResult(
                payment.request({ from, amount, destination }),
                "payment requestPayment failed",
            );
            return { id: response.id };
        },
        subscribePaymentStatus(paymentId, callback) {
            return subscribeWithInterrupt(
                payment.statusSubscribe({ request: { paymentId } }),
                callback,
            );
        },
    };
}

/**
 * Get the host payment manager, backed by `truApi.payment.*`. Returns `null`
 * when running outside a host container.
 *
 * @returns The payment manager, or `null` if unavailable.
 *
 * @example
 * ```ts
 * import { getPaymentManager } from "@parity/product-sdk-host";
 *
 * const payments = await getPaymentManager();
 * if (payments) {
 *   const sub = payments.subscribeBalance((b) => { ... });
 *   await payments.topUp(1_000_000n, { tag: "ProductAccount", value: { derivationIndex: 0 } });
 *   const { id } = await payments.requestPayment(500n, "0x…");
 *   sub.unsubscribe();
 * }
 * ```
 */
export async function getPaymentManager(): Promise<PaymentManager | null> {
    const client = await getClient();
    return client ? adaptPaymentManager(client) : null;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getPaymentManager returns null outside a container", async () => {
        expect(await getPaymentManager()).toBeNull();
    });
}
