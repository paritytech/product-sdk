import { installCoinPaymentReferenceHost } from "@parity/product-sdk-coinpayment";
import { describe, expect, test } from "vitest";
import { createMerchantPaymentsSdk } from "./sdk.js";

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
            context: { appKind: "terminal", externalReference: "ticket-123", displayReference: "A123" },
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

    test("refunds a paid intent through the original receivable", async () => {
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
            refundAmount: { currency: "USD", value: "5.00" },
            executionBasis: "sameAsset",
            idempotencyKey: "refund:refund",
        });
        await eventually(async () => {
            await expect(sdk.getIntent({ intentId: intent.intentId })).resolves.toMatchObject({
                status: { refund: "refunded" },
            });
        });
        expect(["pending", "paid"]).toContain(refund.status);
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
