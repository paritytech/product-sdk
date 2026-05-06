export type AmountDecimal = string;
export type TimestampMs = number;

export type CurrencyCode = "EUR" | "USD" | `other:${string}`;
export type PaymentAsset = "dotUSD" | "dotEUR" | `other:${string}`;
export type PricingMode = "dotUSD" | "eurWithEurobotQuote";
export type ClaimChannel = "statementStore" | "embeddedQr" | "nfc" | "multimodal";
export type MerchantAppKind =
    | "pointOfSale"
    | "ticketing"
    | "invoice"
    | "ecommerce"
    | "subscription"
    | "p2pExchange"
    | `other:${string}`;
export type PurseIsolationPolicy = "sharedMerchantPurse" | "productIsolatedPurse";
export type ClaimStatus = "none" | "ready" | "customerPresent" | "expired";
export type PaymentStatus =
    | "created"
    | "quoted"
    | "pending"
    | "paid"
    | "expired"
    | "failed"
    | "cancelled";
export type ReceiptStatus = "none" | "signed" | "delivered";
export type RefundAggregateStatus =
    | "none"
    | "pending"
    | "partiallyRefunded"
    | "refunded"
    | "failed";
export type RefundStatus = "created" | "pending" | "paid" | "failed";
export type RefundExecutionBasis =
    | "originalPaymentReversal"
    | "originalSaleQuote"
    | "refundTimeQuote"
    | `other:${string}`;
export type RefundReasonCode =
    | "customerReturn"
    | "cashierCorrection"
    | "merchantGoodwill"
    | `other:${string}`;
export type PrivacyMode = "ephemeralCheckoutSession";
export type SignatureAlgorithm = "ed25519" | "developmentDeterministicV1";
export type ReceiptPayloadEncoding = "coseSign1Cbor";
export type ReceiptDeliveryTarget =
    | "pocket"
    | "receiptPocketSpa"
    | "merchantRecordOnly"
    | `other:${string}`;
export type FxQuoteSource = "eurobot" | `other:${string}`;
export type RoundingMode = "halfUp" | "halfEven" | "ceiling" | "floor";

export interface MoneyAmount {
    currency: CurrencyCode;
    value: AmountDecimal;
}

export interface MerchantPaymentScope {
    merchantId: string;
    productId: string;
    scopeId: string;
    productInstanceId?: string;
    locationId?: string;
    pursePolicy: PurseIsolationPolicy;
}

export interface PublicContextEntry {
    namespace: string;
    key: string;
    value: string;
}

export interface MerchantPaymentContext {
    appKind: MerchantAppKind;
    externalReference: string;
    displayReference?: string;
    publicContext: PublicContextEntry[];
}

export interface IntentAggregateStatus {
    claim: ClaimStatus;
    payment: PaymentStatus;
    receipt: ReceiptStatus;
    refund: RefundAggregateStatus;
}

export interface FxQuote {
    quoteId: string;
    source: FxQuoteSource;
    base: CurrencyCode;
    quote: PaymentAsset;
    rate: AmountDecimal;
    quotedAtMs: TimestampMs;
    expiresAtMs: TimestampMs;
    roundingMode: RoundingMode;
}

export interface MerchantActorSummary {
    principalId: string;
    deviceId?: string;
}

export interface PaymentEvidenceSummary {
    evidenceHash: string;
    acceptedAtMs: TimestampMs;
    finalizedReference?: string;
}

export type CoinageRecipientAccountFormat = "hexAccountId32" | "ss58";

export interface CoinageRecipientAccount {
    account: string;
    accountFormat: CoinageRecipientAccountFormat;
    denominationExponent: number;
    derivationIndex?: number;
}

export interface CoinageReceivingMaterial {
    kind: "coinageTransferRecipientsV1";
    recipientAccounts: CoinageRecipientAccount[];
}

export interface CoinageTransferMemoEntry {
    senderCoinAccount?: string;
    recipientAccount: string;
    recipientAccountFormat: CoinageRecipientAccountFormat;
    derivationIndex?: number;
    denominationExponent?: number;
}

export interface PaymentIntent {
    intentId: string;
    createdBy: MerchantActorSummary;
    scope: MerchantPaymentScope;
    context: MerchantPaymentContext;
    saleAmount: MoneyAmount;
    paymentAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
    fxQuote?: FxQuote;
    status: IntentAggregateStatus;
    createdAtMs: TimestampMs;
    expiresAtMs: TimestampMs;
    receiptId?: string;
    evidenceSummary?: PaymentEvidenceSummary;
}

export interface ClaimSession {
    claimId: string;
    intentId: string;
    channel: ClaimChannel;
    qrPayload: string;
    deepLink: string;
    statementStoreTopicHash?: string;
    publicSummaryHash: string;
    expiresAtMs: TimestampMs;
}

export interface PaymentClaimEnvelope {
    version: number;
    claimId: string;
    intentId: string;
    scope: MerchantPaymentScope;
    saleAmount: MoneyAmount;
    paymentAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
    fxQuote?: FxQuote;
    receivingMaterialHash: string;
    receivingMaterial?: CoinageReceivingMaterial;
    publicSummaryHash: string;
    expiresAtMs: TimestampMs;
}

export interface PaymentProof {
    proofId: string;
    intentId: string;
    paymentAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
    receivingMaterialHash: string;
    memoEntriesHash: string;
    memoEntries?: CoinageTransferMemoEntry[];
    finalizedReferences?: string[];
    paidAtMs: TimestampMs;
}

export type IntentEvent =
    | { kind: "claim"; status: ClaimStatus }
    | { kind: "payment"; status: PaymentStatus }
    | { kind: "receipt"; status: ReceiptStatus }
    | { kind: "refund"; status: RefundAggregateStatus }
    | { kind: "error"; error: MerchantPaymentError };

export interface IntentStatusItem {
    intentId: string;
    sequence: number;
    event: IntentEvent;
    occurredAtMs: TimestampMs;
}

export interface CustomerReceiptContext {
    merchantId: string;
    productId: string;
    scopeId: string;
    appKind: MerchantAppKind;
    displayReference?: string;
    locationId?: string;
}

export interface CustomerReceiptPayload {
    version: number;
    receiptId: string;
    intentId: string;
    receiptContext: CustomerReceiptContext;
    merchantDisplayName: string;
    saleAmount: MoneyAmount;
    paymentAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
    fxQuote?: FxQuote;
    acceptedAtMs: TimestampMs;
    refundReference: string;
    privacyMode: PrivacyMode;
    claimEnvelopeHash: string;
    paymentEvidenceHash: string;
    issuerPublicKeyId: string;
}

export interface SignatureEnvelope {
    algorithm: SignatureAlgorithm;
    payloadEncoding: ReceiptPayloadEncoding;
    coveredPayloadHash: string;
    signatureBytes: number[];
}

export interface SupplementalReceipt {
    payload: CustomerReceiptPayload;
    signature: SignatureEnvelope;
}

export interface ReceiptDeliveryReference {
    target: ReceiptDeliveryTarget;
    cid?: string;
    url?: string;
    storageKey?: string;
    deliveredAtMs: TimestampMs;
}

export interface AcceptedMerchantPaymentRecord {
    intent: PaymentIntent;
    receipt: SupplementalReceipt;
}

export interface RefundIntent {
    refundId: string;
    originalIntentId: string;
    createdBy: MerchantActorSummary;
    approvedBy?: MerchantActorSummary;
    refundAmount: MoneyAmount;
    executionBasis: RefundExecutionBasis;
    executionAsset: PaymentAsset;
    executionQuote?: FxQuote;
    status: RefundStatus;
    createdAtMs: TimestampMs;
    paidAtMs?: TimestampMs;
}

export interface MerchantRefundRecord {
    originalIntent: PaymentIntent;
    refund: RefundIntent;
}

export interface PublishPaymentClaimRequest {
    envelope: PaymentClaimEnvelope;
}

export interface PublishPaymentClaimResponse {
    topicHash: string;
}

export interface ResolvePaymentClaimRequest {
    topicHash: string;
}

export interface ResolvePaymentClaimResponse {
    envelope: PaymentClaimEnvelope;
}

export interface PrepareReceivingMaterialRequest {
    scope: MerchantPaymentScope;
    intentId: string;
    paymentAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
}

export interface PrepareReceivingMaterialResponse {
    receivingMaterialHash: string;
    receivingMaterial?: CoinageReceivingMaterial;
}

export interface PayClaimRequest {
    envelope: PaymentClaimEnvelope;
}

export interface PayClaimResponse {
    proof: PaymentProof;
}

export interface VerifyPaymentRequest {
    intent: PaymentIntent;
    expectedReceivingMaterialHash: string;
    expectedReceivingMaterial?: CoinageReceivingMaterial;
    proof: PaymentProof;
}

export interface VerifyPaymentResponse {
    evidenceSummary: PaymentEvidenceSummary;
}

export interface ExecuteRefundRequest {
    originalIntent: PaymentIntent;
    refund: RefundIntent;
    customerRefundClaim?: {
        claimPayload: string;
    };
}

export interface ExecuteRefundResponse {
    refund: RefundIntent;
}

export interface FxQuoteRequest {
    intentId: string;
    createIntent: CreateIntentRequest;
    nowMs: TimestampMs;
}

export interface FxQuoteResponse {
    quote?: FxQuote;
}

export interface PaymentAmountRequest {
    saleAmount: MoneyAmount;
    pricingMode: PricingMode;
    fxQuote?: FxQuote;
}

export interface PaymentAmountResponse {
    paymentAmount: MoneyAmount;
}

export interface SignReceiptRequest {
    payload: CustomerReceiptPayload;
}

export interface SignReceiptResponse {
    signature: SignatureEnvelope;
}

export interface DeliverReceiptRequest {
    intent: PaymentIntent;
    receipt: SupplementalReceipt;
}

export interface DeliverReceiptResponse {
    reference: ReceiptDeliveryReference;
}

export interface RecordAcceptedPaymentRequest {
    record: AcceptedMerchantPaymentRecord;
}

export interface RecordRefundRequest {
    record: MerchantRefundRecord;
}

export interface RefundStatusItem {
    refundId: string;
    sequence: number;
    status: RefundStatus;
    occurredAtMs: TimestampMs;
    error?: MerchantPaymentError;
}

export interface PurseStatusScope {
    merchantId: string;
    productId?: string;
    scopeId?: string;
    productInstanceId?: string;
    locationId?: string;
}

export interface PurseReadiness {
    spendable: MoneyAmount[];
    needsRecycling: MoneyAmount[];
    awaitingVoucherMaturity: MoneyAmount[];
}

export interface MerchantPurseStatus {
    scope: MerchantPaymentScope;
    policy: PurseIsolationPolicy;
    available: MoneyAmount[];
    pending: MoneyAmount[];
    heldForRefunds: MoneyAmount[];
    pendingSettlement: MoneyAmount[];
    readiness: PurseReadiness;
}

export interface CreateIntentRequest {
    idempotencyKey: string;
    scope: MerchantPaymentScope;
    context: MerchantPaymentContext;
    saleAmount: MoneyAmount;
    paymentAsset: PaymentAsset;
    pricingMode: PricingMode;
    expiresAtMs: TimestampMs;
}

export interface CreateIntentResponse {
    intent: PaymentIntent;
}

export interface CreateClaimSessionRequest {
    intentId: string;
    channel: ClaimChannel;
}

export interface CreateClaimSessionResponse {
    claimSession: ClaimSession;
}

export interface GetIntentRequest {
    intentId: string;
}

export interface SubscribeIntentStatusRequest {
    intentId: string;
    fromSequence?: number;
}

export interface CreateRefundIntentRequest {
    idempotencyKey: string;
    originalIntentId: string;
    refundAmount: MoneyAmount;
    executionBasis: RefundExecutionBasis;
    reasonCode: RefundReasonCode;
    customerRefundClaim?: {
        claimPayload: string;
    };
}

export interface CreateRefundIntentResponse {
    refund: RefundIntent;
}

export interface SubscribeRefundStatusRequest {
    refundId: string;
    fromSequence?: number;
}

export type MerchantPaymentError =
    | "invalidAmount"
    | "unsupportedSaleCurrency"
    | "unsupportedPaymentAsset"
    | "unsupportedChannel"
    | "fxQuoteUnavailable"
    | "fxQuoteExpired"
    | "invalidTicketReference"
    | "intentNotFound"
    | "intentAlreadyTerminal"
    | "claimSessionExpired"
    | "claimSessionAlreadyExists"
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
    | "hostCapabilityUnavailable"
    | "internal";

export class MerchantPaymentException extends Error {
    readonly code: MerchantPaymentError;

    constructor(code: MerchantPaymentError, message?: string) {
        super(message ?? code);
        this.name = "MerchantPaymentException";
        this.code = code;
    }
}

export type MerchantPaymentSubscriptionErrorHandler = (error: MerchantPaymentException) => void;

export interface MerchantPaymentsHostApi {
    createIntent(request: CreateIntentRequest): Promise<CreateIntentResponse>;
    createClaimSession(request: CreateClaimSessionRequest): Promise<CreateClaimSessionResponse>;
    getIntent(request: GetIntentRequest): Promise<PaymentIntent>;
    createRefundIntent(request: CreateRefundIntentRequest): Promise<CreateRefundIntentResponse>;
    getPurseStatus(request: { scope: PurseStatusScope }): Promise<MerchantPurseStatus>;
    subscribeIntentStatus(
        request: SubscribeIntentStatusRequest,
        callback: (item: IntentStatusItem) => void,
        onError?: MerchantPaymentSubscriptionErrorHandler,
    ): () => void;
    subscribeRefundStatus(
        request: SubscribeRefundStatusRequest,
        callback: (item: RefundStatusItem) => void,
        onError?: MerchantPaymentSubscriptionErrorHandler,
    ): () => void;
}

export interface MerchantPaymentsReferenceDebugApi {
    resolveClaim(topicHash: string): Promise<PaymentClaimEnvelope>;
    payClaim(envelope: PaymentClaimEnvelope): Promise<PaymentProof>;
    acceptPaymentProof(proof: PaymentProof): Promise<SupplementalReceipt>;
    markCustomerPresent(intentId: string): Promise<void>;
    markPaid(intentId: string): Promise<SupplementalReceipt>;
    markFailed(intentId: string): Promise<void>;
    expireIntent(intentId: string): Promise<void>;
    getReceipt(intentId: string): Promise<SupplementalReceipt | undefined>;
}

export interface UserAgentMerchantPaymentsNamespace {
    merchantPayments?: MerchantPaymentsHostApi;
}

export interface UserAgentNamespace {
    ext?: UserAgentMerchantPaymentsNamespace;
    __merchantPaymentsReference?: MerchantPaymentsReferenceDebugApi;
}
