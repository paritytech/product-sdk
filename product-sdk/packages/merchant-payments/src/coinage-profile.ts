import {
    MerchantPaymentException,
    type ClaimChannel,
    type ClaimSession,
    type CreateClaimSessionRequest,
    type CreateClaimSessionResponse,
    type CreateIntentRequest,
    type CreateIntentResponse,
    type CreateRefundIntentRequest,
    type CreateRefundIntentResponse,
    type IntentStatusItem,
    type MerchantActorSummary,
    type MerchantPaymentsHostApi,
    type MerchantPaymentSubscriptionErrorHandler,
    type MerchantPurseStatus,
    type MoneyAmount,
    type PaymentIntent,
    type PurseStatusScope,
    type RefundIntent,
    type RefundStatusItem,
    type SupplementalReceipt,
} from "./types.js";

type CoinageAsset = "dotUSD" | "dotEUR" | "DOT" | `other:${string}`;

interface CoinageAmount {
    asset: CoinageAsset;
    value: string;
}

interface CoinageNamespace {
    id: string;
    productId: string;
    scopeId: string;
    displayName?: string;
    status: string;
}

interface CoinageReceiveClaim {
    id: string;
    namespaceId: string;
    amount: CoinageAmount;
    channels: string[];
    qrPayload?: string;
    deepLink?: string;
    claimEnvelopeHash: string;
    expiresAtMs: number;
    status: string;
}

interface CoinageReceiveStatusEvent {
    claimId: string;
    sequence: number;
    status: string;
    recordId?: string;
    occurredAtMs: number;
}

interface CoinageSpendStatusEvent {
    spendId: string;
    sequence: number;
    status: string;
    recordId?: string;
    occurredAtMs: number;
}

export interface MerchantPaymentsCoinageClientLike {
    getOrCreateNamespace(request: {
        scopeId: string;
        displayName?: string;
        idempotencyKey?: string;
    }): Promise<CoinageNamespace>;
    getPurseStatus(namespaceId: string): Promise<{
        namespaceId: string;
        asset: CoinageAsset;
        available: CoinageAmount;
        pending: CoinageAmount;
        reserved: CoinageAmount;
        pendingOffload: CoinageAmount;
        readiness: {
            canReceive: boolean;
            canSpend: boolean;
            canReserve: boolean;
        };
    }>;
    createReceiveClaim(request: {
        namespaceId: string;
        amount: CoinageAmount;
        externalReference?: string;
        displayReference?: string;
        expiresAtMs?: number;
        channels: string[];
        idempotencyKey?: string;
    }): Promise<CoinageReceiveClaim>;
    subscribeReceiveStatus(
        request: { claimId: string; fromSequence?: number },
        callback: (item: CoinageReceiveStatusEvent) => void,
    ): () => void;
    createSpendRequest(request: {
        namespaceId: string;
        amount: CoinageAmount;
        destination: { kind: "claim"; claimId: string } | { kind: "externalOpaque"; value: string };
        externalReference?: string;
        displayReference?: string;
        idempotencyKey?: string;
    }): Promise<{ id: string; status: string }>;
    subscribeSpendStatus(
        request: { spendId: string; fromSequence?: number },
        callback: (item: CoinageSpendStatusEvent) => void,
    ): () => void;
}

export interface CoinageBackedMerchantPaymentsOptions {
    coinage: MerchantPaymentsCoinageClientLike;
    actor?: MerchantActorSummary;
    merchantDisplayName?: string;
    nowMs?: () => number;
}

interface IntentState {
    intent: PaymentIntent;
    namespaceId: string;
    claim?: ClaimSession;
    claimUnsubscribe?: () => void;
    refund?: RefundIntent;
    spendId?: string;
    spendUnsubscribe?: () => void;
}

export class CoinageBackedMerchantPaymentsClient implements MerchantPaymentsHostApi {
    private readonly intents = new Map<string, IntentState>();
    private readonly intentSubscribers = new Map<
        string,
        Map<string, (item: IntentStatusItem) => void>
    >();
    private readonly refundSubscribers = new Map<
        string,
        Map<string, (item: RefundStatusItem) => void>
    >();
    private nextSubscriber = 1;

    constructor(private readonly options: CoinageBackedMerchantPaymentsOptions) {}

    async createIntent(request: CreateIntentRequest): Promise<CreateIntentResponse> {
        if (Number(request.saleAmount.value) <= 0) {
            throw new MerchantPaymentException("invalidAmount");
        }
        if (request.pricingMode !== "dotUSD" || request.paymentAsset !== "dotUSD") {
            throw new MerchantPaymentException(
                "fxQuoteUnavailable",
                "Coinage-backed product profile currently supports dotUSD-priced intents only.",
            );
        }

        const existing = [...this.intents.values()].find(
            (entry) => entry.intent.context.externalReference === request.context.externalReference,
        );
        if (existing) return { intent: existing.intent };

        const namespace = await this.options.coinage.getOrCreateNamespace({
            scopeId: request.scope.scopeId,
            displayName: this.options.merchantDisplayName ?? request.scope.merchantId,
            idempotencyKey: `${request.scope.scopeId}:namespace`,
        });
        const now = this.now();
        const intent: PaymentIntent = {
            intentId: `intent-${request.idempotencyKey}`,
            createdBy: this.options.actor ?? { principalId: "product" },
            scope: request.scope,
            context: request.context,
            saleAmount: request.saleAmount,
            paymentAmount: request.saleAmount,
            paymentAsset: request.paymentAsset,
            status: {
                claim: "none",
                payment: "created",
                receipt: "none",
                refund: "none",
            },
            createdAtMs: now,
            expiresAtMs: request.expiresAtMs,
        };
        this.intents.set(intent.intentId, { intent, namespaceId: namespace.id });
        return { intent };
    }

    async createClaimSession(
        request: CreateClaimSessionRequest,
    ): Promise<CreateClaimSessionResponse> {
        const state = this.requireIntent(request.intentId);
        if (state.claim) return { claimSession: state.claim };

        const claim = await this.options.coinage.createReceiveClaim({
            namespaceId: state.namespaceId,
            amount: {
                asset: state.intent.paymentAsset as CoinageAsset,
                value: state.intent.paymentAmount.value,
            },
            externalReference: state.intent.context.externalReference,
            displayReference: state.intent.context.displayReference,
            expiresAtMs: state.intent.expiresAtMs,
            channels: [mapClaimChannel(request.channel)],
            idempotencyKey: `${state.intent.intentId}:claim:${request.channel}`,
        });
        const claimSession: ClaimSession = {
            claimId: claim.id,
            intentId: state.intent.intentId,
            channel: request.channel,
            qrPayload: claim.qrPayload ?? claim.deepLink ?? `ua://coinage/claim/${claim.id}`,
            deepLink: claim.deepLink ?? claim.qrPayload ?? `ua://coinage/claim/${claim.id}`,
            publicSummaryHash: claim.claimEnvelopeHash,
            expiresAtMs: claim.expiresAtMs,
        };

        state.claim = claimSession;
        state.intent.status = { ...state.intent.status, claim: "ready", payment: "pending" };
        this.emitIntent(state.intent.intentId, {
            intentId: state.intent.intentId,
            sequence: 1,
            event: { kind: "claim", status: "ready" },
            occurredAtMs: this.now(),
        });

        state.claimUnsubscribe = this.options.coinage.subscribeReceiveStatus(
            { claimId: claim.id, fromSequence: 1 },
            (item) => this.applyReceiveStatus(state, item),
        );

        return { claimSession };
    }

    async getIntent(request: { intentId: string }): Promise<PaymentIntent> {
        return this.requireIntent(request.intentId).intent;
    }

    async getReceipt(): Promise<{ receipt?: SupplementalReceipt }> {
        return {};
    }

    async createRefundIntent(
        request: CreateRefundIntentRequest,
    ): Promise<CreateRefundIntentResponse> {
        const state = this.requireIntent(request.originalIntentId);
        if (!request.customerRefundClaim?.claimPayload) {
            throw new MerchantPaymentException(
                "refundNotAllowed",
                "Coinage-backed product profile requires a customer refund claim.",
            );
        }
        const now = this.now();
        const refund: RefundIntent = {
            refundId: `refund-${request.idempotencyKey}`,
            originalIntentId: request.originalIntentId,
            createdBy: this.options.actor ?? { principalId: "product" },
            refundAmount: request.refundAmount,
            executionBasis: request.executionBasis,
            executionAsset: state.intent.paymentAsset,
            status: "pending",
            createdAtMs: now,
        };
        const spend = await this.options.coinage.createSpendRequest({
            namespaceId: state.namespaceId,
            amount: {
                asset: state.intent.paymentAsset as CoinageAsset,
                value: request.refundAmount.value,
            },
            destination: {
                kind: "externalOpaque",
                value: request.customerRefundClaim.claimPayload,
            },
            externalReference: state.intent.context.externalReference,
            displayReference: state.intent.context.displayReference,
            idempotencyKey: `${refund.refundId}:spend`,
        });
        state.refund = refund;
        state.spendId = spend.id;
        state.intent.status = { ...state.intent.status, refund: "pending" };
        state.spendUnsubscribe = this.options.coinage.subscribeSpendStatus(
            { spendId: spend.id, fromSequence: 1 },
            (item) => this.applySpendStatus(state, item),
        );
        return { refund };
    }

    async getPurseStatus(request: { scope: PurseStatusScope }): Promise<MerchantPurseStatus> {
        const namespace = await this.options.coinage.getOrCreateNamespace({
            scopeId: request.scope.scopeId ?? request.scope.merchantId,
            displayName: request.scope.merchantId,
            idempotencyKey: `${request.scope.scopeId ?? request.scope.merchantId}:namespace`,
        });
        const status = await this.options.coinage.getPurseStatus(namespace.id);
        const scope = {
            merchantId: request.scope.merchantId,
            productId: namespace.productId,
            scopeId: namespace.scopeId,
            pursePolicy: "sharedMerchantPurse" as const,
            productInstanceId: request.scope.productInstanceId,
            locationId: request.scope.locationId,
        };
        return {
            scope,
            policy: "sharedMerchantPurse",
            available: [toMoney(status.available)],
            pending: [toMoney(status.pending)],
            heldForRefunds: [toMoney(status.reserved)],
            pendingSettlement: [toMoney(status.pendingOffload)],
            readiness: {
                spendable: status.readiness.canSpend ? [toMoney(status.available)] : [],
                needsRecycling: [],
                awaitingVoucherMaturity: [],
            },
        };
    }

    subscribeIntentStatus(
        request: { intentId: string; fromSequence?: number },
        callback: (item: IntentStatusItem) => void,
        _onError?: MerchantPaymentSubscriptionErrorHandler,
    ): () => void {
        this.requireIntent(request.intentId);
        const subscriptionId = `intent-sub-${this.nextSubscriber++}`;
        const subscribers = this.intentSubscribers.get(request.intentId) ?? new Map();
        subscribers.set(subscriptionId, callback);
        this.intentSubscribers.set(request.intentId, subscribers);
        return () => subscribers.delete(subscriptionId);
    }

    subscribeRefundStatus(
        request: { refundId: string },
        callback: (item: RefundStatusItem) => void,
        _onError?: MerchantPaymentSubscriptionErrorHandler,
    ): () => void {
        const subscriptionId = `refund-sub-${this.nextSubscriber++}`;
        const subscribers = this.refundSubscribers.get(request.refundId) ?? new Map();
        subscribers.set(subscriptionId, callback);
        this.refundSubscribers.set(request.refundId, subscribers);
        return () => subscribers.delete(subscriptionId);
    }

    private requireIntent(intentId: string): IntentState {
        const state = this.intents.get(intentId);
        if (!state) throw new MerchantPaymentException("intentNotFound");
        return state;
    }

    private applyReceiveStatus(state: IntentState, item: CoinageReceiveStatusEvent): void {
        if (item.status !== "received") return;
        const now = item.occurredAtMs;
        state.intent = {
            ...state.intent,
            status: { ...state.intent.status, payment: "paid" },
            evidenceSummary: {
                evidenceHash: item.recordId ?? `${item.claimId}:${item.sequence}`,
                acceptedAtMs: now,
                finalizedReference: item.recordId,
            },
        };
        this.emitIntent(state.intent.intentId, {
            intentId: state.intent.intentId,
            sequence: item.sequence + 1,
            event: { kind: "payment", status: "paid" },
            occurredAtMs: now,
        });
    }

    private applySpendStatus(state: IntentState, item: CoinageSpendStatusEvent): void {
        if (!state.refund) return;
        if (item.status !== "completed" && item.status !== "failed") return;
        const status = item.status === "completed" ? "paid" : "failed";
        state.refund = {
            ...state.refund,
            status,
            paidAtMs: status === "paid" ? item.occurredAtMs : state.refund.paidAtMs,
        };
        state.intent.status = {
            ...state.intent.status,
            refund: status === "paid" ? "refunded" : "failed",
        };
        this.emitRefund(state.refund.refundId, {
            refundId: state.refund.refundId,
            sequence: item.sequence,
            status,
            occurredAtMs: item.occurredAtMs,
        });
    }

    private emitIntent(intentId: string, item: IntentStatusItem): void {
        const subscribers = this.intentSubscribers.get(intentId);
        if (!subscribers) return;
        for (const callback of subscribers.values()) {
            callback(item);
        }
    }

    private emitRefund(refundId: string, item: RefundStatusItem): void {
        const subscribers = this.refundSubscribers.get(refundId);
        if (!subscribers) return;
        for (const callback of subscribers.values()) {
            callback(item);
        }
    }

    private now(): number {
        return this.options.nowMs?.() ?? Date.now();
    }
}

export function createCoinageBackedMerchantPaymentsClient(
    options: CoinageBackedMerchantPaymentsOptions,
): CoinageBackedMerchantPaymentsClient {
    return new CoinageBackedMerchantPaymentsClient(options);
}

function mapClaimChannel(channel: ClaimChannel): string {
    if (channel === "statementStore") return "statementStore";
    if (channel === "embeddedQr") return "embeddedQr";
    return "deepLink";
}

function toMoney(amount: CoinageAmount): MoneyAmount {
    return {
        currency: amount.asset === "dotEUR" ? "EUR" : "USD",
        value: amount.value,
    };
}
