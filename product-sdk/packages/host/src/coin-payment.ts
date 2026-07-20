// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's CoinPayment manager (RFC-0017), backed by
 * `truApi.coinPayment.*`.
 *
 * Exposes the firewalled-purse lifecycle (create/query/rebalance/delete),
 * receivables and cheques, deposits/refunds, and the listen-for-payment
 * handoff channel. Distinct from the RFC-0006 payment surface
 * ({@link module:payments}): RFC-0017 is the merchant/coin-clearing flow whose
 * long-running operations are `Resolvable<T>` values, surfaced here as
 * {@link HostSubscription}s streaming {@link CoinPaymentStatus} updates.
 *
 * @module
 */

import type {
    CoinPaymentBalance,
    CoinPaymentCheque,
    CoinPaymentPurseId,
    CoinPaymentPurseInfo,
    CoinPaymentReceivable,
    CoinPaymentStatus,
    HostCoinPaymentListenForItem,
    TrUApiClient,
} from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/**
 * CoinPayment manager handle (RFC-0017). One-shot methods reject with a
 * diagnostic `Error` on the host's `Err` channel; long-running operations
 * return a {@link HostSubscription} that streams {@link CoinPaymentStatus}
 * clearing updates (`Clearing` → `Done` / `Failed`) until unsubscribed.
 *
 * The purse / cheque / receivable / status shapes are `@parity/truapi`'s
 * `CoinPayment*` types — used directly rather than re-aliased.
 */
export interface CoinPaymentManager {
    /** Create a new firewalled purse; resolves to its id. */
    createPurse(name: string): Promise<CoinPaymentPurseId>;
    /** Query product-visible purse metadata and balance. */
    queryPurse(purse: CoinPaymentPurseId): Promise<CoinPaymentPurseInfo>;
    /** Create a fresh receivable public key for depositing into a purse. */
    createReceivable(into: CoinPaymentPurseId): Promise<CoinPaymentReceivable>;
    /** Create a cheque paying `amount` from a local purse to a receivable. */
    createCheque(
        from: CoinPaymentPurseId,
        to: CoinPaymentReceivable,
        amount: CoinPaymentBalance,
    ): Promise<CoinPaymentCheque>;
    /** Transfer balance between local purses, streaming clearing status. */
    rebalancePurse(
        from: CoinPaymentPurseId,
        to: CoinPaymentPurseId,
        amount: CoinPaymentBalance,
        callback: (status: CoinPaymentStatus) => void,
    ): HostSubscription;
    /** Delete a purse after draining its balance into another local purse. */
    deletePurse(
        target: CoinPaymentPurseId,
        drainInto: CoinPaymentPurseId,
        callback: (status: CoinPaymentStatus) => void,
    ): HostSubscription;
    /** Claim coins from a cheque into the receivable's purse. */
    deposit(
        cheque: CoinPaymentCheque,
        callback: (status: CoinPaymentStatus) => void,
    ): HostSubscription;
    /** Attempt to return coins associated with a receivable. */
    refund(
        receivable: CoinPaymentReceivable,
        callback: (status: CoinPaymentStatus) => void,
    ): HostSubscription;
    /**
     * Listen for a cheque delivered through a standard transmission channel:
     * the stream first emits the `Channel` to include in an invoice, then the
     * received `Cheque`(s).
     */
    listenForPayment(
        receivable: CoinPaymentReceivable,
        callback: (item: HostCoinPaymentListenForItem) => void,
    ): HostSubscription;
}

/** Build a {@link CoinPaymentManager} over a TruAPI client's `coinPayment` domain. */
function adaptCoinPaymentManager(client: TrUApiClient): CoinPaymentManager {
    const coinPayment = client.coinPayment;
    return {
        async createPurse(name) {
            const response = await unwrapHostResult(
                coinPayment.createPurse({ name }),
                "coinPayment createPurse failed",
            );
            return response.purse;
        },
        async queryPurse(purse) {
            const response = await unwrapHostResult(
                coinPayment.queryPurse({ purse }),
                "coinPayment queryPurse failed",
            );
            return response.info;
        },
        async createReceivable(into) {
            const response = await unwrapHostResult(
                coinPayment.createReceivable({ into }),
                "coinPayment createReceivable failed",
            );
            return response.receivable;
        },
        async createCheque(from, to, amount) {
            const response = await unwrapHostResult(
                coinPayment.createCheque({ from, to, amount }),
                "coinPayment createCheque failed",
            );
            return response.cheque;
        },
        rebalancePurse(from, to, amount, callback) {
            return subscribeWithInterrupt(
                coinPayment.rebalancePurse({ request: { from, to, amount } }),
                callback,
            );
        },
        deletePurse(target, drainInto, callback) {
            return subscribeWithInterrupt(
                coinPayment.deletePurse({ request: { target, drainInto } }),
                callback,
            );
        },
        deposit(cheque, callback) {
            return subscribeWithInterrupt(coinPayment.deposit({ request: { cheque } }), callback);
        },
        refund(receivable, callback) {
            return subscribeWithInterrupt(
                coinPayment.refund({ request: { receivable } }),
                callback,
            );
        },
        listenForPayment(receivable, callback) {
            return subscribeWithInterrupt(
                coinPayment.listenForPayment({ request: { receivable } }),
                callback,
            );
        },
    };
}

/**
 * Get the host CoinPayment manager, backed by `truApi.coinPayment.*`. Returns
 * `null` when running outside a host container.
 *
 * @returns The CoinPayment manager, or `null` if unavailable.
 *
 * @example
 * ```ts
 * import { getCoinPaymentManager } from "@parity/product-sdk-host";
 *
 * const coinPayments = await getCoinPaymentManager();
 * if (coinPayments) {
 *   const purse = await coinPayments.createPurse("shop till");
 *   const receivable = await coinPayments.createReceivable(purse);
 *   const sub = coinPayments.listenForPayment(receivable, (item) => { ... });
 *   sub.unsubscribe();
 * }
 * ```
 */
export async function getCoinPaymentManager(): Promise<CoinPaymentManager | null> {
    const client = await getClient();
    return client ? adaptCoinPaymentManager(client) : null;
}

if (import.meta.vitest) {
    const { test, expect, vi } = import.meta.vitest;

    test("getCoinPaymentManager returns null outside a container", async () => {
        expect(await getCoinPaymentManager()).toBeNull();
    });

    test("one-shots unwrap the response and subscriptions adapt the stream", async () => {
        const calls: Array<[string, unknown]> = [];
        const okAsync = <T>(value: T) => ({
            match: async (onOk: (v: T) => unknown) => onOk(value),
        });
        const method = (name: string, response: unknown) => (args: unknown) => {
            calls.push([name, args]);
            return okAsync(response);
        };
        const observable = (name: string) => (args: unknown) => {
            calls.push([name, args]);
            return {
                subscribe: () => ({ unsubscribe: vi.fn() }),
                [Symbol.observable as symbol]() {
                    return this;
                },
            };
        };
        const fakeClient = {
            coinPayment: {
                createPurse: method("createPurse", { purse: 7 }),
                queryPurse: method("queryPurse", {
                    info: { name: "till", created: 1n, creator: "shop.dot", balance: 5 },
                }),
                createReceivable: method("createReceivable", { receivable: "0xaa" }),
                createCheque: method("createCheque", {
                    cheque: { id: "0xaa", amount: 3, encryptedSecrets: "0xbb" },
                }),
                rebalancePurse: observable("rebalancePurse"),
                deletePurse: observable("deletePurse"),
                deposit: observable("deposit"),
                refund: observable("refund"),
                listenForPayment: observable("listenForPayment"),
            },
        } as unknown as TrUApiClient;

        const manager = adaptCoinPaymentManager(fakeClient);
        expect(await manager.createPurse("till")).toBe(7);
        expect((await manager.queryPurse(7)).name).toBe("till");
        expect(await manager.createReceivable(7)).toBe("0xaa");
        expect((await manager.createCheque(7, "0xaa", 3)).amount).toBe(3);
        const sub = manager.rebalancePurse(7, 8, 3, () => {});
        sub.unsubscribe();

        expect(calls).toEqual([
            ["createPurse", { name: "till" }],
            ["queryPurse", { purse: 7 }],
            ["createReceivable", { into: 7 }],
            ["createCheque", { from: 7, to: "0xaa", amount: 3 }],
            ["rebalancePurse", { request: { from: 7, to: 8, amount: 3 } }],
        ]);
    });
}
