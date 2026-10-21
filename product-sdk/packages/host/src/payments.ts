// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's payment manager (RFC-0006), backed by
 * `truApi.payment.*`.
 *
 * Exposes balance subscription, top-up, payment requests, and payment-status
 * subscription. The flow is distinct from the CoinPayment / merchant-payments
 * surface (RFC-0017) — RFC-0006 is the user-initiated balance / top-up /
 * payment-request flow — but both operate on the same CoinPayment purses,
 * hence the shared `CoinPaymentPurseId` (omitted = the main purse).
 *
 * @module
 */

import type {
    HexString,
    HostPaymentBalanceSubscribeItem,
    HostPaymentStatusSubscribeItem,
    PaymentTopUpSource,
    TrUApiClient,
} from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { toHex, unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/**
 * A fresh 32-byte id for a payment or top-up session. truapi 0.26 made the
 * caller own the id, so a reload can keep watching an in-flight session and a
 * retry is idempotent (`AlreadyExists` is refused). Callers that need those
 * guarantees pass their own id; the default is a random one.
 */
function randomId(): HexString {
    return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

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
        purse?: number,
    ): HostSubscription;
    topUp(
        amount: bigint,
        source: PaymentTopUpSource,
        into?: number,
        id?: HexString,
    ): Promise<{ id: HexString }>;
    requestPayment(
        amount: bigint,
        destination: HexString,
        from?: number,
        id?: HexString,
    ): Promise<{ id: HexString }>;
    subscribePaymentStatus(
        id: HexString,
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
        async topUp(amount, source, into, id) {
            const topUpId = id ?? randomId();
            await unwrapHostResult(
                payment.topUp({ id: topUpId, into, amount, source }),
                "payment topUp failed",
            );
            return { id: topUpId };
        },
        async requestPayment(amount, destination, from, id) {
            const paymentId = id ?? randomId();
            await unwrapHostResult(
                payment.request({ id: paymentId, from, amount, destination }),
                "payment requestPayment failed",
            );
            return { id: paymentId };
        },
        subscribePaymentStatus(id, callback) {
            return subscribeWithInterrupt(payment.statusSubscribe({ request: { id } }), callback);
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
 *   await payments.topUp(1_000_000n, { tag: "ProductAccount", value: { derivationIndex: { tag: "Index", value: 0 } } });
 *   const { id } = await payments.requestPayment(500n, "0x…");
 *   const status = payments.subscribePaymentStatus(id, (s) => { ... });
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
