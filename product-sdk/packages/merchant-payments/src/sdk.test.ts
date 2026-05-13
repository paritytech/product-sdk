import { installCoinPaymentReferenceHost } from "@parity/product-sdk-coinpayment";
import { describe, expect, test } from "vitest";
import { MemoryMerchantPaymentRecordStore } from "./memory-store.js";
import { createMerchantPaymentsSdk } from "./sdk.js";
import type { MerchantPaymentException } from "./types.js";

const scope = {
    merchantId: "merchant-demo",
    productId: "terminal.dot",
    scopeId: "store:berlin",
    locationId: "berlin",
    productInstanceId: "terminal-1",
};

describe("merchant payments SDK over CoinPayment", () => {
    test("creates invoice, deposits paid cheque, emits paid state, and returns receipt", async () => {
        const coinpayment = installCoinPaymentReferenceHost({ initialMainBalance: 5000 });
        const sdk = createMerchantPaymentsSdk({
            coinpayment,
            merchantDisplayName: "Funkhaus Bar",
            actor: { principalId: "owner@example", deviceId: "terminal-1" },
        });

        const { intent } = await sdk.createIntent({
            scope,
            saleAmount: { currency: "USD", value: "12.50" },
            paymentAsset: "dotUSD",
            context: {
                appKind: "terminal",
                externalReference: "ticket-123",
                displayReference: "A123",
            },
            idempotencyKey: "ticket-123:intent",
        });
        const paidEvents: string[] = [];
        sdk.subscribeIntentStatus({ intentId: intent.intentId, fromSequence: 1 }, (item) => {
            paidEvents.push(`${item.event.kind}:${item.event.status}`);
        });

        const { invoice } = await sdk.createInvoice({
            intentId: intent.intentId,
            channel: "embeddedQr",
            idempotencyKey: "ticket-123:invoice",
        });
        await coinpayment.payInvoice(invoice.invoice);
        await eventually(async () => {
            await expect(sdk.getIntent({ intentId: intent.intentId })).resolves.toMatchObject({
                status: { payment: "paid", receipt: "signed" },
            });
        });

        const { receipt } = await sdk.getReceipt({ intentId: intent.intentId });
        expect(receipt).toMatchObject({
            merchantDisplayName: "Funkhaus Bar",
            saleAmount: { value: "12.50" },
            invoiceHash: invoice.invoiceHash,
        });
        expect(receipt?.clearingReference).toBeDefined();
        expect(paidEvents).toContain("payment:paid");
    });

    test("tracks partial refunds and executes the original receivable refund when fully refunded", async () => {
        const coinpayment = installCoinPaymentReferenceHost({ initialMainBalance: 5000 });
        const sdk = createMerchantPaymentsSdk({ coinpayment });
        const { intent } = await sdk.createIntent({
            scope,
            saleAmount: { currency: "USD", value: "5.00" },
            paymentAsset: "dotUSD",
            context: { appKind: "terminal" },
            idempotencyKey: "refund:intent",
        });
        const { invoice } = await sdk.createInvoice({
            intentId: intent.intentId,
            channel: "embeddedQr",
            idempotencyKey: "refund:invoice",
        });
        await coinpayment.payInvoice(invoice.invoice);
        await eventually(async () => {
            await expect(sdk.getIntent({ intentId: intent.intentId })).resolves.toMatchObject({
                status: { payment: "paid" },
            });
        });

        const { refund } = await sdk.createRefundIntent({
            originalIntentId: intent.intentId,
            refundAmount: { currency: "USD", value: "2.00" },
            executionBasis: "merchantLedgerCredit",
            idempotencyKey: "refund:partial",
        });
        await eventually(async () => {
            await expect(sdk.getIntent({ intentId: intent.intentId })).resolves.toMatchObject({
                status: { refund: "partiallyRefunded" },
            });
        });
        expect(["pending", "paid"]).toContain(refund.status);

        const { refund: finalRefund } = await sdk.createRefundIntent({
            originalIntentId: intent.intentId,
            refundAmount: { currency: "USD", value: "3.00" },
            executionBasis: "merchantLedgerCredit",
            idempotencyKey: "refund:final",
        });
        await eventually(async () => {
            await expect(sdk.getIntent({ intentId: intent.intentId })).resolves.toMatchObject({
                status: { refund: "refunded" },
            });
        });
        expect(["pending", "paid"]).toContain(finalRefund.status);
    });

    test("uses CoinPayment refund for a one-shot full original payment reversal", async () => {
        const coinpayment = installCoinPaymentReferenceHost({ initialMainBalance: 5000 });
        const sdk = createMerchantPaymentsSdk({ coinpayment });
        const { intent } = await sdk.createIntent({
            scope,
            saleAmount: { currency: "USD", value: "4.00" },
            paymentAsset: "dotUSD",
            context: { appKind: "terminal" },
            idempotencyKey: "full-refund:intent",
        });
        const { invoice } = await sdk.createInvoice({
            intentId: intent.intentId,
            channel: "embeddedQr",
            idempotencyKey: "full-refund:invoice",
        });
        await coinpayment.payInvoice(invoice.invoice);
        await eventually(async () => {
            await expect(sdk.getIntent({ intentId: intent.intentId })).resolves.toMatchObject({
                status: { payment: "paid" },
            });
        });

        await sdk.createRefundIntent({
            originalIntentId: intent.intentId,
            refundAmount: { currency: "USD", value: "4.00" },
            executionBasis: "originalPaymentReversal",
            idempotencyKey: "full-refund:refund",
        });

        await eventually(async () => {
            await expect(sdk.getIntent({ intentId: intent.intentId })).resolves.toMatchObject({
                status: { refund: "refunded" },
            });
        });
    });

    test("returns idempotent results and rejects materially different retries", async () => {
        const sdk = createMerchantPaymentsSdk({
            coinpayment: installCoinPaymentReferenceHost({ initialMainBalance: 5000 }),
        });
        const request = {
            scope,
            saleAmount: { currency: "USD" as const, value: "5.00" },
            paymentAsset: "dotUSD" as const,
            context: { appKind: "terminal" },
            idempotencyKey: "idem:intent",
        };

        const first = await sdk.createIntent(request);
        const retry = await sdk.createIntent({ ...request });
        expect(retry.intent.intentId).toBe(first.intent.intentId);

        await expect(
            sdk.createIntent({
                ...request,
                saleAmount: { currency: "USD", value: "6.00" },
            }),
        ).rejects.toMatchObject({ code: "idempotencyConflict" });

        const { invoice } = await sdk.createInvoice({
            intentId: first.intent.intentId,
            channel: "embeddedQr",
            idempotencyKey: "idem:invoice",
        });
        const invoiceRetry = await sdk.createInvoice({
            intentId: first.intent.intentId,
            channel: "embeddedQr",
            idempotencyKey: "idem:invoice",
        });
        expect(invoiceRetry.invoice.invoiceId).toBe(invoice.invoiceId);
        await expect(
            sdk.createInvoice({
                intentId: first.intent.intentId,
                channel: "deepLink",
                idempotencyKey: "idem:invoice",
            }),
        ).rejects.toMatchObject({ code: "idempotencyConflict" });
    });

    test("persists intents, invoices, receipts, and events through SDK recreation", async () => {
        const coinpayment = installCoinPaymentReferenceHost({ initialMainBalance: 5000 });
        const recordStore = new MemoryMerchantPaymentRecordStore();
        const sdk = createMerchantPaymentsSdk({ coinpayment, recordStore });
        const { intent } = await sdk.createIntent({
            scope,
            saleAmount: { currency: "USD", value: "3.25" },
            paymentAsset: "dotUSD",
            context: { appKind: "terminal" },
            idempotencyKey: "persist:intent",
        });
        const { invoice } = await sdk.createInvoice({
            intentId: intent.intentId,
            channel: "embeddedQr",
            idempotencyKey: "persist:invoice",
        });
        await coinpayment.payInvoice(invoice.invoice);
        await eventually(async () => {
            await expect(sdk.getReceipt({ intentId: intent.intentId })).resolves.toMatchObject({
                receipt: { invoiceHash: invoice.invoiceHash },
            });
        });

        const reloaded = createMerchantPaymentsSdk({ coinpayment, recordStore });
        await expect(reloaded.getIntent({ intentId: intent.intentId })).resolves.toMatchObject({
            status: { payment: "paid", receipt: "signed" },
        });
        await expect(reloaded.getReceipt({ intentId: intent.intentId })).resolves.toMatchObject({
            receipt: { invoiceHash: invoice.invoiceHash },
        });
    });

    test("locks a EUR quote and creates a dotUSD invoice amount", async () => {
        const sdk = createMerchantPaymentsSdk({
            coinpayment: installCoinPaymentReferenceHost({ initialMainBalance: 5000 }),
        });
        const { intent } = await sdk.createIntent({
            scope,
            saleAmount: { currency: "EUR", value: "10.00" },
            paymentAsset: "dotUSD",
            pricingMode: "eurQuote",
            context: { appKind: "terminal" },
            idempotencyKey: "eur:intent",
        });

        expect(intent.fxQuote).toMatchObject({ source: "eurobot" });
        expect(intent.paymentAmount).toEqual({ currency: "USD", value: "11.00" });
        const { invoice } = await sdk.createInvoice({
            intentId: intent.intentId,
            channel: "embeddedQr",
            idempotencyKey: "eur:invoice",
        });
        expect(invoice.invoice.amount).toBe(1100);
    });

    test("surfaces subscription setup errors through the error callback", async () => {
        const sdk = createMerchantPaymentsSdk({
            coinpayment: installCoinPaymentReferenceHost({ initialMainBalance: 5000 }),
        });
        const errors: MerchantPaymentException[] = [];
        sdk.subscribeIntentStatus(
            { intentId: "missing" },
            () => {},
            (error) => {
                errors.push(error);
            },
        );

        await eventually(async () => {
            expect(errors).toMatchObject([{ code: "intentNotFound" }]);
        });
    });
});

async function eventually(assertion: () => Promise<void>, attempts = 20): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw lastError;
}
