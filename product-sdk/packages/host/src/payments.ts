/**
 * Wrapper for the host's payment manager (RFC-0006).
 *
 * Shipped flat-in-host rather than as `getTruApi().payment.*` because the
 * upstream JS `hostApi` is itself a flat object - there is no `.payment`
 * accessor to mirror. A flat `getPaymentManager()` matches the singleton
 * pattern already used by {@link getPreimageManager},
 * {@link getHostLocalStorage}, and {@link getAccountsProvider}.
 *
 * Returns the shared `paymentManager` singleton from
 * `@novasamatech/host-api-wrapper` (not a fresh `createPaymentManager()`
 * instance) so callers share one wrapper + hostApi closure across the app.
 *
 * Distinct from the CoinPayment / merchant-payments surface tracked under
 * `@parity/product-sdk-merchant-payments` (RFC-0017). RFC-0006 is the
 * user-initiated balance / top-up / payment-request flow; RFC-0017 is the
 * merchant-initiated checkout flow.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import type {
    PaymentBalance as NovasamaPaymentBalance,
    PaymentStatus as NovasamaPaymentStatus,
    TopUpSource as NovasamaTopUpSource,
    paymentManager,
} from "@novasamatech/host-api-wrapper";

const log = createLogger("host:payments");

/** Available balance for the user's payment account. Re-exported from `@novasamatech/host-api-wrapper`. */
export type PaymentBalance = NovasamaPaymentBalance;

/** Status of an in-flight payment request. Re-exported from `@novasamatech/host-api-wrapper`. */
export type PaymentStatus = NovasamaPaymentStatus;

/** Source for {@link PaymentManager.topUp}. Re-exported from `@novasamatech/host-api-wrapper`. */
export type TopUpSource = NovasamaTopUpSource;

/**
 * Payment manager handle. Exposes balance subscription, top-up, payment
 * requests, and payment status subscription.
 *
 * Type identical to `paymentManager` from `@novasamatech/host-api-wrapper`.
 */
export type PaymentManager = typeof paymentManager;

/**
 * Get the host payment manager.
 *
 * Returns the shared `paymentManager` singleton from
 * `@novasamatech/host-api-wrapper`, or `null` if the package is unavailable
 * (running outside a host container or the optional peer dep isn't
 * installed).
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
 *   await payments.topUp(1_000_000n, { type: "productAccount", derivationIndex: 0 });
 *   const destination = new Uint8Array(32);
 *   const { id } = await payments.requestPayment(500n, destination);
 *   sub.unsubscribe();
 * }
 * ```
 */
export async function getPaymentManager(): Promise<PaymentManager | null> {
    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.paymentManager;
    } catch (err) {
        log.debug("getPaymentManager unavailable", err);
        return null;
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getPaymentManager returns manager with full RFC-0006 surface when SDK is available", async () => {
        const payments = await getPaymentManager();
        if (payments === null) {
            // Acceptable: SDK couldn't load (e.g. peer dep missing in some envs).
            return;
        }
        expect(typeof payments.subscribeBalance).toBe("function");
        expect(typeof payments.topUp).toBe("function");
        expect(typeof payments.requestPayment).toBe("function");
        expect(typeof payments.subscribePaymentStatus).toBe("function");
    });
}
