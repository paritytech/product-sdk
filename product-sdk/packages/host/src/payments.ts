// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's payment manager (RFC-0006), backed by
 * `truApi.payment.*`.
 *
 * Exposes balance subscription, top-ups and payment requests, and a status
 * subscription for each. The flow is distinct from the CoinPayment / merchant-payments
 * surface (RFC-0017) — RFC-0006 is the user-initiated balance / top-up /
 * payment-request flow — but both operate on the same CoinPayment purses,
 * hence the shared `CoinPaymentPurseId` (omitted = the main purse).
 *
 * Top-ups and payment requests are identified by a 32-byte id the product
 * chooses. Starting one again under the same id is answered `AlreadyExists`
 * rather than moving funds twice, so a product that derives its ids from its
 * own state can retry safely after a restart, and follow the outcome with the
 * id it already has. {@link newPaymentId} makes a fresh random id for a
 * product with nothing to derive one from.
 *
 * @module
 */

import type {
    HexString,
    HostPaymentBalanceSubscribeItem,
    HostPaymentStatusSubscribeItem,
    HostPaymentTopUpStatusSubscribeItem,
    PaymentTopUpSource,
    TrUApiClient,
} from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { toHex, unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/** A top-up the product starts: an id it chooses, the amount and where the funds come from. */
export interface TopUpRequest {
    /** 32-byte id. Reusing one is answered `AlreadyExists`. */
    id: HexString;
    /** Amount in balance units. Zero is refused as `InvalidAmount`. */
    amount: bigint;
    /** Where the funds come from. */
    source: PaymentTopUpSource;
    /** Purse to credit; omitted credits the main purse. */
    into?: number;
}

/** A payment the product asks the user to approve: an id it chooses, the amount and the payee. */
export interface PaymentRequest {
    /** 32-byte id. Reusing one is answered `AlreadyExists`. */
    id: HexString;
    /** Amount in balance units. Zero is refused as `InvalidAmount`. */
    amount: bigint;
    /** 32-byte account the payment goes to. */
    destination: HexString;
    /** Purse to pay from; omitted pays from the main purse. */
    from?: number;
}

/**
 * Payment manager handle. Exposes balance subscription, top-ups and payment
 * requests by id, and a status subscription for each.
 *
 * The balance / status / top-up-source shapes are `@parity/truapi`'s
 * `HostPaymentBalanceSubscribeItem`, `HostPaymentStatusSubscribeItem`,
 * `HostPaymentTopUpStatusSubscribeItem` and `PaymentTopUpSource` — used
 * directly rather than re-aliased.
 */
export interface PaymentManager {
    /** Follow the spendable balance of `purse` (the main purse when omitted). */
    subscribeBalance(
        callback: (balance: HostPaymentBalanceSubscribeItem) => void,
        purse?: number,
    ): HostSubscription;
    /** Start a top-up. Resolves once the host has taken it; follow it with {@link subscribeTopUpStatus}. */
    topUp(request: TopUpRequest): Promise<void>;
    /**
     * Follow a top-up by its id. `Claimed { finalized: true }`, `ClaimedPartially`
     * and `NotClaimed` are final; the host keeps answering them after the top-up ends.
     */
    subscribeTopUpStatus(
        id: HexString,
        callback: (status: HostPaymentTopUpStatusSubscribeItem) => void,
    ): HostSubscription;
    /**
     * Ask the user to approve a payment. Resolves once the user approved it;
     * follow it with {@link subscribePaymentStatus}.
     */
    requestPayment(request: PaymentRequest): Promise<void>;
    /**
     * Follow a payment by its id. `Completed`, `ClaimedPartially` and `Failed`
     * are final; the host keeps answering them after the payment ends.
     */
    subscribePaymentStatus(
        id: HexString,
        callback: (status: HostPaymentStatusSubscribeItem) => void,
    ): HostSubscription;
}

/**
 * A fresh random 32-byte id for a top-up or payment request.
 *
 * Prefer an id derived from the product's own state when it has one (an order
 * id, a session and step): a restart then finds the same id again, and the host
 * answers `AlreadyExists` instead of moving funds twice. A random id is only
 * safe when the product stores it before it starts the top-up or payment.
 */
export function newPaymentId(): HexString {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return toHex(bytes);
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
        topUp({ id, amount, source, into }) {
            return unwrapHostResult(
                payment.topUp({ id, into, amount, source }),
                "payment topUp failed",
            );
        },
        subscribeTopUpStatus(id, callback) {
            return subscribeWithInterrupt(
                payment.topUpStatusSubscribe({ request: { id } }),
                callback,
            );
        },
        requestPayment({ id, amount, destination, from }) {
            return unwrapHostResult(
                payment.request({ id, from, amount, destination }),
                "payment requestPayment failed",
            );
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
 * import { getPaymentManager, newPaymentId } from "@parity/product-sdk-host";
 *
 * const payments = await getPaymentManager();
 * if (payments) {
 *   const sub = payments.subscribeBalance((b) => { ... });
 *
 *   const topUp = newPaymentId();
 *   await payments.topUp({
 *     id: topUp,
 *     amount: 1_000_000n,
 *     source: { tag: "ProductAccount", value: { derivationIndex: { tag: "Index", value: 0 } } },
 *   });
 *   payments.subscribeTopUpStatus(topUp, (status) => { ... });
 *
 *   const payment = newPaymentId();
 *   await payments.requestPayment({ id: payment, amount: 500n, destination: "0x…" });
 *   payments.subscribePaymentStatus(payment, (status) => { ... });
 *   sub.unsubscribe();
 * }
 * ```
 */
export async function getPaymentManager(): Promise<PaymentManager | null> {
    const client = await getClient();
    return client ? adaptPaymentManager(client) : null;
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;
    const { okAsync } = await import("neverthrow");

    test("getPaymentManager returns null outside a container", async () => {
        expect(await getPaymentManager()).toBeNull();
    });

    test("newPaymentId is 32 random bytes", () => {
        const a = newPaymentId();
        const b = newPaymentId();
        expect(a).toMatch(/^0x[0-9a-f]{64}$/);
        expect(a).not.toBe(b);
    });

    describe("adaptPaymentManager", () => {
        const id = `0x${"ab".repeat(32)}` as HexString;
        const destination = `0x${"cd".repeat(32)}` as HexString;

        function stubClient() {
            const calls: Array<[string, unknown]> = [];
            const observable = (name: string) => (args: unknown) => {
                calls.push([name, args]);
                return {
                    subscribe: () => ({ unsubscribe: () => {}, subscriptionId: name }),
                };
            };
            const payment = {
                topUp: (args: unknown) => {
                    calls.push(["topUp", args]);
                    return okAsync(undefined);
                },
                request: (args: unknown) => {
                    calls.push(["request", args]);
                    return okAsync(undefined);
                },
                balanceSubscribe: observable("balanceSubscribe"),
                statusSubscribe: observable("statusSubscribe"),
                topUpStatusSubscribe: observable("topUpStatusSubscribe"),
            };
            return { client: { payment } as unknown as TrUApiClient, calls };
        }

        test("a top-up carries the product's id", async () => {
            const { client, calls } = stubClient();
            const source = { tag: "Coins", value: { coins: [] } } as unknown as PaymentTopUpSource;
            await adaptPaymentManager(client).topUp({ id, amount: 5n, source });
            expect(calls).toEqual([["topUp", { id, into: undefined, amount: 5n, source }]]);
        });

        test("a payment request carries the product's id and resolves with nothing", async () => {
            const { client, calls } = stubClient();
            const result = await adaptPaymentManager(client).requestPayment({
                id,
                amount: 7n,
                destination,
                from: 1,
            });
            expect(result).toBeUndefined();
            expect(calls).toEqual([["request", { id, from: 1, amount: 7n, destination }]]);
        });

        test("statuses are followed by id", () => {
            const { client, calls } = stubClient();
            const manager = adaptPaymentManager(client);
            manager.subscribePaymentStatus(id, () => {});
            manager.subscribeTopUpStatus(id, () => {});
            expect(calls).toEqual([
                ["statusSubscribe", { request: { id } }],
                ["topUpStatusSubscribe", { request: { id } }],
            ]);
        });
    });
}
