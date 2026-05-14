import type {
    Balance,
    ClearingReference,
    CoinPaymentHostApi,
    Invoice,
    PurseId,
    Receivable,
} from "@parity/product-sdk-coin-payment";

export type PaymentAsset = "dotUSD";
export type Currency = "USD" | "EUR";
export type MerchantPaymentInvoiceChannel = "statementStore" | "embeddedQr" | "deepLink";
export type PricingMode = "dotUSD" | "eurQuote";

export interface MoneyAmount {
    currency: Currency;
    value: string;
}

export interface MerchantPaymentScope {
    merchantId: string;
    productId: string;
    scopeId: string;
    locationId?: string;
    productInstanceId?: string;
}

export interface MerchantActorSummary {
    principalId: string;
    deviceId?: string;
}

export interface MerchantPaymentContext {
    appKind: "terminal" | "ticketing" | "invoice" | "ecommerce" | "marketplace" | string;
    externalReference?: string;
    displayReference?: string;
}

export interface FxQuote {
    source: string;
    rateNumerator: string;
    rateDenominator: string;
    quotedAtMs: number;
    expiresAtMs: number;
    roundingMode: "halfUp" | "floor" | "ceil";
}

export type InvoiceStatus = "none" | "ready" | "expired";
export type PaymentStatus =
    | "created"
    | "quoted"
    | "pending"
    | "paid"
    | "expired"
    | "failed"
    | "cancelled";
export type ReceiptStatus = "none" | "signed" | "delivered";
export type RefundStatus = "none" | "pending" | "partiallyRefunded" | "refunded" | "failed";

export interface MerchantPaymentStatus {
    invoice: InvoiceStatus;
    payment: PaymentStatus;
    receipt: ReceiptStatus;
    refund: RefundStatus;
    error?: string;
}

export interface MerchantPaymentIntentCreate {
    scope: MerchantPaymentScope;
    saleAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
    pricingMode?: PricingMode;
    context: MerchantPaymentContext;
    expiresAtMs?: number;
    idempotencyKey: string;
}

export interface MerchantPaymentIntent {
    intentId: string;
    scope: MerchantPaymentScope;
    context: MerchantPaymentContext;
    saleAmount: MoneyAmount;
    paymentAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
    fxQuote?: FxQuote;
    status: MerchantPaymentStatus;
    createdBy: MerchantActorSummary;
    createdAtMs: number;
    expiresAtMs?: number;
    receiptId?: string;
    clearingReference?: ClearingReference;
}

export interface MerchantPaymentIntentCreateResponse {
    intent: MerchantPaymentIntent;
}

export interface MerchantPaymentIntentGet {
    intentId: string;
}

export interface MerchantPaymentInvoiceCreate {
    intentId: string;
    channel: MerchantPaymentInvoiceChannel;
    idempotencyKey: string;
}

export interface MerchantPaymentInvoice {
    invoiceId: string;
    intentId: string;
    receivable: Receivable;
    channel: MerchantPaymentInvoiceChannel;
    invoice: Invoice;
    qrPayload: string;
    deepLink: string;
    expiresAtMs?: number;
    invoiceHash: string;
}

export interface MerchantPaymentInvoiceCreateResponse {
    invoice: MerchantPaymentInvoice;
}

export type MerchantPaymentEvent =
    | { kind: "invoice"; status: InvoiceStatus }
    | { kind: "payment"; status: PaymentStatus }
    | { kind: "receipt"; status: ReceiptStatus }
    | { kind: "refund"; status: RefundStatus };

export interface MerchantPaymentStatusEvent {
    intentId: string;
    sequence: number;
    event: MerchantPaymentEvent;
    status: MerchantPaymentStatus;
    occurredAtMs: number;
}

export interface MerchantPaymentIntentStatusSubscribe {
    intentId: string;
    fromSequence?: number;
}

export interface MerchantPaymentReceipt {
    id: string;
    merchantDisplayName: string;
    scope: MerchantPaymentScope;
    saleAmount: MoneyAmount;
    paymentAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
    fxQuote?: FxQuote;
    displayReference?: string;
    acceptedAtMs: number;
    refundReference?: string;
    invoiceHash: string;
    clearingReference?: ClearingReference;
    paymentEvidenceHash: string;
    signature: Uint8Array;
}

export interface MerchantPaymentReceiptResponse {
    receipt?: MerchantPaymentReceipt;
}

export interface MerchantPaymentRefundIntentCreate {
    originalIntentId: string;
    refundAmount: MoneyAmount;
    executionBasis:
        | "originalPaymentReversal"
        | "originalSaleQuote"
        | "refundTimeQuote"
        | "sameAsset"
        | "merchantLedgerCredit";
    idempotencyKey: string;
}

export interface MerchantPaymentRefundIntent {
    refundId: string;
    originalIntentId: string;
    refundAmount: MoneyAmount;
    executionBasis: MerchantPaymentRefundIntentCreate["executionBasis"];
    executionAsset: PaymentAsset;
    status: "created" | "pending" | "paid" | "failed";
    createdBy: MerchantActorSummary;
    approvedBy?: MerchantActorSummary;
    createdAtMs: number;
    paidAtMs?: number;
    clearingReference?: ClearingReference;
}

export interface MerchantPaymentRefundIntentCreateResponse {
    refund: MerchantPaymentRefundIntent;
}

export interface MerchantPaymentRefundStatusEvent {
    refundId: string;
    sequence: number;
    status: MerchantPaymentRefundIntent["status"];
    occurredAtMs: number;
}

export interface MerchantPaymentRefundStatusSubscribe {
    refundId: string;
    fromSequence?: number;
}

export interface MerchantPurseStatus {
    scope: MerchantPaymentScope;
    purseId: PurseId;
    available: Balance;
    clearing: Balance;
    cleared: Balance;
    retainedForRefunds: Balance;
    pendingSettlement: Balance;
    readiness: {
        canReceive: boolean;
        canTransfer: boolean;
    };
}

export interface MerchantPaymentPurseStatusGet {
    scope: MerchantPaymentScope;
}

export type MerchantPaymentErr =
    | "invalidAmount"
    | "unsupportedSaleCurrency"
    | "unsupportedPaymentAsset"
    | "unsupportedChannel"
    | "fxQuoteUnavailable"
    | "fxQuoteExpired"
    | "invalidTicketReference"
    | "intentNotFound"
    | "intentAlreadyTerminal"
    | "invoiceExpired"
    | "invoiceAlreadyExists"
    | "statementStoreUnavailable"
    | "receiptUnavailable"
    | "refundNotAllowed"
    | "refundAmountExceedsOriginal"
    | "idempotencyConflict"
    | "invalidPublicContext"
    | "purseUnavailable"
    | "permissionDenied"
    | "authenticationRequired"
    | "refundApprovalRequired"
    | "userAgentCapabilityUnavailable"
    | "internal";

export class MerchantPaymentException extends Error {
    constructor(
        readonly code: MerchantPaymentErr,
        message: string = code,
    ) {
        super(message);
        this.name = "MerchantPaymentException";
    }
}

export interface MerchantPaymentRecordStore {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
}

export interface MerchantPaymentsSdkOptions {
    coinpayment: CoinPaymentHostApi;
    merchantDisplayName?: string;
    actor?: MerchantActorSummary;
    recordStore?: MerchantPaymentRecordStore;
    acceptUnfinalizedRisk?: boolean;
}

export interface MerchantPaymentsSdk {
    createIntent(
        request: MerchantPaymentIntentCreate,
    ): Promise<MerchantPaymentIntentCreateResponse>;
    getIntent(request: MerchantPaymentIntentGet): Promise<MerchantPaymentIntent>;
    createInvoice(
        request: MerchantPaymentInvoiceCreate,
    ): Promise<MerchantPaymentInvoiceCreateResponse>;
    subscribeIntentStatus(
        request: MerchantPaymentIntentStatusSubscribe,
        callback: (item: MerchantPaymentStatusEvent) => void,
        onError?: (error: MerchantPaymentException) => void,
    ): () => void;
    getReceipt(request: MerchantPaymentIntentGet): Promise<MerchantPaymentReceiptResponse>;
    createRefundIntent(
        request: MerchantPaymentRefundIntentCreate,
    ): Promise<MerchantPaymentRefundIntentCreateResponse>;
    subscribeRefundStatus(
        request: MerchantPaymentRefundStatusSubscribe,
        callback: (item: MerchantPaymentRefundStatusEvent) => void,
        onError?: (error: MerchantPaymentException) => void,
    ): () => void;
    getPurseStatus(request: MerchantPaymentPurseStatusGet): Promise<MerchantPurseStatus>;
}
