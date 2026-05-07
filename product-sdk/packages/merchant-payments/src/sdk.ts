import {
    CoinPaymentException,
    type Balance,
    type Cheque,
    type CoinPaymentStatus,
    type Invoice,
    type PurseId,
} from "@parity/product-sdk-coinpayment";
import { MemoryMerchantPaymentRecordStore } from "./memory-store.js";
import {
    MerchantPaymentException,
    type MerchantPaymentEvent,
    type MerchantPaymentIntent,
    type MerchantPaymentIntentCreate,
    type MerchantPaymentIntentCreateResponse,
    type MerchantPaymentInvoice,
    type MerchantPaymentInvoiceCreate,
    type MerchantPaymentInvoiceCreateResponse,
    type MerchantPaymentReceipt,
    type MerchantPaymentRecordStore,
    type MerchantPaymentRefundIntent,
    type MerchantPaymentRefundIntentCreate,
    type MerchantPaymentRefundIntentCreateResponse,
    type MerchantPaymentRefundStatusEvent,
    type MerchantPaymentStatusEvent,
    type MerchantPaymentsSdk,
    type MerchantPaymentsSdkOptions,
    type MoneyAmount,
} from "./types.js";

interface IntentRecord {
    intent: MerchantPaymentIntent;
    purseId: PurseId;
    invoices: Map<string, MerchantPaymentInvoice>;
    receivableInvoiceId?: string;
    receipt?: MerchantPaymentReceipt;
    events: MerchantPaymentStatusEvent[];
    refundedMinor: number;
}

interface RefundRecord {
    refund: MerchantPaymentRefundIntent;
    events: MerchantPaymentRefundStatusEvent[];
}

interface PersistedState {
    nextId: number;
    purseByScope: Array<[string, PurseId]>;
    intentIdempotency: Array<[string, string]>;
    invoiceIdempotency: Array<[string, string]>;
    refundIdempotency: Array<[string, string]>;
    intents: Array<{
        intent: MerchantPaymentIntent;
        purseId: PurseId;
        invoices: Array<[string, MerchantPaymentInvoice]>;
        receivableInvoiceId?: string;
        receipt?: MerchantPaymentReceipt;
        events: MerchantPaymentStatusEvent[];
        refundedMinor: number;
    }>;
    refunds: Array<RefundRecord>;
}

const STORE_KEY = "merchant-payments:v1";

export function createMerchantPaymentsSdk(options: MerchantPaymentsSdkOptions): MerchantPaymentsSdk {
    return new DefaultMerchantPaymentsSdk(options);
}

class DefaultMerchantPaymentsSdk implements MerchantPaymentsSdk {
    private readonly store: MerchantPaymentRecordStore;
    private readonly purseByScope = new Map<string, PurseId>();
    private readonly intents = new Map<string, IntentRecord>();
    private readonly refunds = new Map<string, RefundRecord>();
    private readonly intentIdempotency = new Map<string, string>();
    private readonly invoiceIdempotency = new Map<string, string>();
    private readonly refundIdempotency = new Map<string, string>();
    private readonly intentSubscribers = new Map<string, Set<(item: MerchantPaymentStatusEvent) => void>>();
    private readonly refundSubscribers = new Map<string, Set<(item: MerchantPaymentRefundStatusEvent) => void>>();
    private loaded?: Promise<void>;
    private nextId = 1;

    constructor(private readonly options: MerchantPaymentsSdkOptions) {
        this.store = options.recordStore ?? new MemoryMerchantPaymentRecordStore();
    }

    async createIntent(request: MerchantPaymentIntentCreate): Promise<MerchantPaymentIntentCreateResponse> {
        await this.load();
        validateIntent(request);
        const existing = this.intentIdempotency.get(request.idempotencyKey);
        if (existing) return { intent: structuredClone(this.requireIntent(existing).intent) };

        const purseId = await this.getOrCreatePurse(request.scope);
        const now = Date.now();
        const intent: MerchantPaymentIntent = {
            intentId: this.id("intent"),
            scope: request.scope,
            context: request.context,
            saleAmount: request.saleAmount,
            paymentAmount: request.saleAmount,
            paymentAsset: request.paymentAsset,
            status: { invoice: "none", payment: "quoted", receipt: "none", refund: "none" },
            createdBy: this.options.actor ?? { principalId: "merchant-operator", deviceId: request.scope.productInstanceId },
            createdAtMs: now,
            expiresAtMs: request.expiresAtMs,
        };
        const record: IntentRecord = {
            intent,
            purseId,
            invoices: new Map(),
            events: [],
            refundedMinor: 0,
        };
        this.intents.set(intent.intentId, record);
        this.intentIdempotency.set(request.idempotencyKey, intent.intentId);
        this.pushIntentEvent(record, { kind: "payment", status: "created" }, now);
        this.pushIntentEvent(record, { kind: "payment", status: "quoted" }, now);
        await this.persist();
        return { intent: structuredClone(intent) };
    }

    async getIntent(request: { intentId: string }): Promise<MerchantPaymentIntent> {
        await this.load();
        return structuredClone(this.requireIntent(request.intentId).intent);
    }

    async createInvoice(request: MerchantPaymentInvoiceCreate): Promise<MerchantPaymentInvoiceCreateResponse> {
        await this.load();
        const record = this.requireIntent(request.intentId);
        if (record.intent.status.payment === "paid" || record.intent.status.payment === "failed") {
            throw new MerchantPaymentException("intentAlreadyTerminal");
        }
        if (isExpired(record.intent.expiresAtMs)) {
            this.expireIntent(record);
            await this.persist();
            throw new MerchantPaymentException("invoiceExpired");
        }
        const existingId = this.invoiceIdempotency.get(request.idempotencyKey);
        if (existingId) return { invoice: structuredClone(this.requireInvoice(record, existingId)) };

        const receivable = await this.options.coinpayment.createReceivable(record.purseId);
        const { channel, cheque } = await this.options.coinpayment.listenFor(receivable);
        const invoice: Invoice = {
            version: 0,
            handoff: channel,
            receiver: receivable,
            amount: parseMinorUnits(record.intent.paymentAmount),
        };
        const invoiceSession: MerchantPaymentInvoice = {
            invoiceId: this.id("invoice"),
            intentId: record.intent.intentId,
            receivable,
            channel: request.channel,
            invoice,
            qrPayload: encodeInvoice(invoice),
            deepLink: encodeInvoice(invoice),
            expiresAtMs: record.intent.expiresAtMs,
            invoiceHash: stableHash(JSON.stringify(serializeInvoice(invoice))),
        };
        record.invoices.set(invoiceSession.invoiceId, invoiceSession);
        record.receivableInvoiceId = invoiceSession.invoiceId;
        this.invoiceIdempotency.set(request.idempotencyKey, invoiceSession.invoiceId);
        record.intent.status.invoice = "ready";
        record.intent.status.payment = "pending";
        this.pushIntentEvent(record, { kind: "invoice", status: "ready" }, Date.now());
        this.pushIntentEvent(record, { kind: "payment", status: "pending" }, Date.now());
        void this.awaitCheque(record.intent.intentId, invoiceSession.invoiceId, cheque);
        await this.persist();
        return { invoice: structuredClone(invoiceSession) };
    }

    subscribeIntentStatus(
        request: { intentId: string; fromSequence?: number },
        callback: (item: MerchantPaymentStatusEvent) => void,
        onError?: (error: MerchantPaymentException) => void,
    ): () => void {
        void this.load().then(() => {
            try {
                const record = this.requireIntent(request.intentId);
                for (const item of record.events) {
                    if (item.sequence >= (request.fromSequence ?? 0)) queueMicrotask(() => callback(structuredClone(item)));
                }
                const subscribers = this.intentSubscribers.get(request.intentId) ?? new Set();
                subscribers.add(callback);
                this.intentSubscribers.set(request.intentId, subscribers);
            } catch (error) {
                onError?.(toMerchantError(error));
            }
        }, (error) => onError?.(toMerchantError(error)));
        return () => this.intentSubscribers.get(request.intentId)?.delete(callback);
    }

    async getReceipt(request: { intentId: string }): Promise<{ receipt?: MerchantPaymentReceipt }> {
        await this.load();
        return { receipt: structuredClone(this.requireIntent(request.intentId).receipt) };
    }

    async createRefundIntent(request: MerchantPaymentRefundIntentCreate): Promise<MerchantPaymentRefundIntentCreateResponse> {
        await this.load();
        const record = this.requireIntent(request.originalIntentId);
        if (record.intent.status.payment !== "paid" || !record.receivableInvoiceId) {
            throw new MerchantPaymentException("refundNotAllowed");
        }
        const refundMinor = parseMinorUnits(request.refundAmount);
        const originalMinor = parseMinorUnits(record.intent.saleAmount);
        if (refundMinor <= 0 || refundMinor !== originalMinor || record.refundedMinor > 0) {
            throw new MerchantPaymentException("refundAmountExceedsOriginal");
        }
        const existing = this.refundIdempotency.get(request.idempotencyKey);
        if (existing) return { refund: structuredClone(this.requireRefund(existing).refund) };

        const refund: MerchantPaymentRefundIntent = {
            refundId: this.id("refund"),
            originalIntentId: record.intent.intentId,
            refundAmount: request.refundAmount,
            executionBasis: request.executionBasis,
            executionAsset: record.intent.paymentAsset,
            status: "pending",
            createdBy: this.options.actor ?? record.intent.createdBy,
            approvedBy: this.options.actor ?? record.intent.createdBy,
            createdAtMs: Date.now(),
        };
        const refundRecord: RefundRecord = { refund, events: [] };
        this.refunds.set(refund.refundId, refundRecord);
        this.refundIdempotency.set(request.idempotencyKey, refund.refundId);
        this.pushRefundStatus(refundRecord, "created", refund.createdAtMs);
        this.pushRefundStatus(refundRecord, "pending", refund.createdAtMs);

        const invoice = this.requireInvoice(record, record.receivableInvoiceId);
        const operation = await this.options.coinpayment.refund(invoice.receivable);
        operation.subscribe((status) => {
            if (status.kind === "done") {
                refundRecord.refund.status = "paid";
                refundRecord.refund.paidAtMs = Date.now();
                refundRecord.refund.clearingReference = status.clearingReference;
                record.refundedMinor = originalMinor;
                record.intent.status.refund = "refunded";
                this.pushRefundStatus(refundRecord, "paid", refundRecord.refund.paidAtMs);
                this.pushIntentEvent(record, { kind: "refund", status: "refunded" }, refundRecord.refund.paidAtMs);
                void this.persist();
            } else if (status.kind === "failed") {
                refundRecord.refund.status = "failed";
                record.intent.status.refund = "failed";
                this.pushRefundStatus(refundRecord, "failed", Date.now());
                this.pushIntentEvent(record, { kind: "refund", status: "failed" }, Date.now());
                void this.persist();
            }
        });
        await this.persist();
        return { refund: structuredClone(refund) };
    }

    subscribeRefundStatus(
        request: { refundId: string; fromSequence?: number },
        callback: (item: MerchantPaymentRefundStatusEvent) => void,
        onError?: (error: MerchantPaymentException) => void,
    ): () => void {
        void this.load().then(() => {
            try {
                const record = this.requireRefund(request.refundId);
                for (const item of record.events) {
                    if (item.sequence >= (request.fromSequence ?? 0)) queueMicrotask(() => callback(structuredClone(item)));
                }
                const subscribers = this.refundSubscribers.get(request.refundId) ?? new Set();
                subscribers.add(callback);
                this.refundSubscribers.set(request.refundId, subscribers);
            } catch (error) {
                onError?.(toMerchantError(error));
            }
        }, (error) => onError?.(toMerchantError(error)));
        return () => this.refundSubscribers.get(request.refundId)?.delete(callback);
    }

    async getPurseStatus(request: { scope: MerchantPaymentIntent["scope"] }) {
        await this.load();
        const purseId = await this.getOrCreatePurse(request.scope);
        const purse = await this.options.coinpayment.queryPurse(purseId);
        return {
            scope: request.scope,
            purseId,
            available: purse.balance,
            clearing: 0,
            cleared: purse.balance,
            retainedForRefunds: 0,
            pendingSettlement: 0,
            readiness: { canReceive: true, canTransfer: true },
        };
    }

    private async awaitCheque(intentId: string, invoiceId: string, chequePromise: Promise<Cheque>): Promise<void> {
        try {
            const cheque = await chequePromise;
            const record = this.requireIntent(intentId);
            const invoice = this.requireInvoice(record, invoiceId);
            if (isExpired(record.intent.expiresAtMs)) {
                this.expireIntent(record);
                await this.persist();
                return;
            }
            if (cheque.amount !== invoice.invoice.amount) {
                record.intent.status.payment = "failed";
                record.intent.status.error = "amountMismatch";
                this.pushIntentEvent(record, { kind: "payment", status: "failed" }, Date.now());
                await this.persist();
                return;
            }
            const operation = await this.options.coinpayment.deposit(cheque);
            operation.subscribe((status) => {
                this.applyDepositStatus(record, invoice, status);
                void this.persist();
            });
        } catch (error) {
            const record = this.intents.get(intentId);
            if (record) {
                record.intent.status.payment = "failed";
                record.intent.status.error = toMerchantError(error).code;
                this.pushIntentEvent(record, { kind: "payment", status: "failed" }, Date.now());
                await this.persist();
            }
        }
    }

    private applyDepositStatus(record: IntentRecord, invoice: MerchantPaymentInvoice, status: CoinPaymentStatus): void {
        if (record.intent.status.payment === "paid" || record.intent.status.payment === "failed") return;
        if (status.kind === "clearing") {
            this.pushIntentEvent(record, { kind: "payment", status: "pending" }, Date.now());
            if (!this.options.acceptUnfinalizedRisk) return;
        }
        if (status.kind === "failed") {
            record.intent.status.payment = "failed";
            record.intent.status.error = status.error;
            this.pushIntentEvent(record, { kind: "payment", status: "failed" }, Date.now());
            return;
        }
        if (status.kind === "done" || (status.kind === "clearing" && this.options.acceptUnfinalizedRisk)) {
            const now = Date.now();
            record.intent.status.payment = "paid";
            record.intent.status.receipt = "signed";
            record.intent.receiptId = this.id("receipt");
            if (status.kind === "done") record.intent.clearingReference = status.clearingReference;
            record.receipt = this.buildReceipt(record.intent, invoice, now);
            this.pushIntentEvent(record, { kind: "payment", status: "paid" }, now);
            this.pushIntentEvent(record, { kind: "receipt", status: "signed" }, now);
        }
    }

    private buildReceipt(intent: MerchantPaymentIntent, invoice: MerchantPaymentInvoice, acceptedAtMs: number): MerchantPaymentReceipt {
        const id = intent.receiptId ?? this.id("receipt");
        const payload = JSON.stringify({
            id,
            intentId: intent.intentId,
            saleAmount: intent.saleAmount,
            paymentAmount: intent.paymentAmount,
            paymentAsset: intent.paymentAsset,
            invoiceHash: invoice.invoiceHash,
            clearingReference: intent.clearingReference ? serializeClearingReference(intent.clearingReference) : undefined,
            acceptedAtMs,
        });
        return {
            id,
            merchantDisplayName: this.options.merchantDisplayName ?? intent.scope.merchantId,
            scope: intent.scope,
            saleAmount: intent.saleAmount,
            paymentAmount: intent.paymentAmount,
            paymentAsset: intent.paymentAsset,
            fxQuote: intent.fxQuote,
            displayReference: intent.context.displayReference,
            acceptedAtMs,
            refundReference: `refund:${intent.intentId}`,
            invoiceHash: invoice.invoiceHash,
            clearingReference: intent.clearingReference,
            paymentEvidenceHash: stableHash(payload),
            signature: new TextEncoder().encode(`development-signature:${stableHash(payload)}`),
        };
    }

    private expireIntent(record: IntentRecord): void {
        record.intent.status.invoice = "expired";
        record.intent.status.payment = "expired";
        this.pushIntentEvent(record, { kind: "invoice", status: "expired" }, Date.now());
        this.pushIntentEvent(record, { kind: "payment", status: "expired" }, Date.now());
    }

    private pushIntentEvent(record: IntentRecord, event: MerchantPaymentEvent, occurredAtMs: number): void {
        const item = {
            intentId: record.intent.intentId,
            sequence: record.events.length + 1,
            event,
            status: structuredClone(record.intent.status),
            occurredAtMs,
        };
        record.events.push(item);
        for (const subscriber of this.intentSubscribers.get(record.intent.intentId) ?? []) {
            queueMicrotask(() => subscriber(structuredClone(item)));
        }
    }

    private pushRefundStatus(record: RefundRecord, status: MerchantPaymentRefundIntent["status"], occurredAtMs: number): void {
        const item = { refundId: record.refund.refundId, sequence: record.events.length + 1, status, occurredAtMs };
        record.events.push(item);
        for (const subscriber of this.refundSubscribers.get(record.refund.refundId) ?? []) {
            queueMicrotask(() => subscriber(structuredClone(item)));
        }
    }

    private async getOrCreatePurse(scope: MerchantPaymentIntent["scope"]): Promise<PurseId> {
        const key = scopeKey(scope);
        const existing = this.purseByScope.get(key);
        if (existing !== undefined) return existing;
        const purseId = await this.options.coinpayment.createPurse(`${scope.merchantId}/${scope.scopeId}`);
        this.purseByScope.set(key, purseId);
        await this.persist();
        return purseId;
    }

    private requireIntent(intentId: string): IntentRecord {
        const record = this.intents.get(intentId);
        if (!record) throw new MerchantPaymentException("intentNotFound");
        return record;
    }

    private requireInvoice(record: IntentRecord, invoiceId: string): MerchantPaymentInvoice {
        const invoice = record.invoices.get(invoiceId);
        if (!invoice) throw new MerchantPaymentException("invoiceExpired");
        return invoice;
    }

    private requireRefund(refundId: string): RefundRecord {
        const record = this.refunds.get(refundId);
        if (!record) throw new MerchantPaymentException("intentNotFound");
        return record;
    }

    private id(prefix: string): string {
        return `${prefix}-${this.nextId++}`;
    }

    private async load(): Promise<void> {
        this.loaded ??= this.loadState();
        await this.loaded;
    }

    private async loadState(): Promise<void> {
        const state = await this.store.get<PersistedState>(STORE_KEY);
        if (!state) return;
        this.nextId = state.nextId;
        restoreMap(this.purseByScope, state.purseByScope);
        restoreMap(this.intentIdempotency, state.intentIdempotency);
        restoreMap(this.invoiceIdempotency, state.invoiceIdempotency);
        restoreMap(this.refundIdempotency, state.refundIdempotency);
        for (const item of state.intents) {
            this.intents.set(item.intent.intentId, {
                intent: item.intent,
                purseId: item.purseId,
                invoices: new Map(item.invoices),
                receivableInvoiceId: item.receivableInvoiceId,
                receipt: item.receipt,
                events: item.events,
                refundedMinor: item.refundedMinor,
            });
        }
        for (const refund of state.refunds) this.refunds.set(refund.refund.refundId, refund);
    }

    private async persist(): Promise<void> {
        const state: PersistedState = {
            nextId: this.nextId,
            purseByScope: [...this.purseByScope],
            intentIdempotency: [...this.intentIdempotency],
            invoiceIdempotency: [...this.invoiceIdempotency],
            refundIdempotency: [...this.refundIdempotency],
            intents: [...this.intents.values()].map((record) => ({
                intent: record.intent,
                purseId: record.purseId,
                invoices: [...record.invoices],
                receivableInvoiceId: record.receivableInvoiceId,
                receipt: record.receipt,
                events: record.events,
                refundedMinor: record.refundedMinor,
            })),
            refunds: [...this.refunds.values()],
        };
        await this.store.set(STORE_KEY, state);
    }
}

function restoreMap<K, V>(map: Map<K, V>, entries: Array<[K, V]>): void {
    map.clear();
    for (const [key, value] of entries) map.set(key, value);
}

function validateIntent(request: MerchantPaymentIntentCreate): void {
    if (parseMinorUnits(request.saleAmount) <= 0) throw new MerchantPaymentException("invalidAmount");
    if (request.paymentAsset !== "dotUSD") throw new MerchantPaymentException("unsupportedPaymentAsset");
    if (request.saleAmount.currency !== "USD" && request.saleAmount.currency !== "EUR") {
        throw new MerchantPaymentException("unsupportedSaleCurrency");
    }
}

function parseMinorUnits(amount: MoneyAmount): Balance {
    const value = amount.value.trim();
    if (!/^\d+(\.\d{0,2})?$/.test(value)) throw new MerchantPaymentException("invalidAmount");
    const [units = "0", decimals = ""] = value.split(".");
    return Number(units) * 100 + Number(decimals.padEnd(2, "0"));
}

function isExpired(expiresAtMs: number | undefined): boolean {
    return expiresAtMs !== undefined && Date.now() > expiresAtMs;
}

function scopeKey(scope: MerchantPaymentIntent["scope"]): string {
    return [scope.productId, scope.merchantId, scope.scopeId, scope.locationId ?? "", scope.productInstanceId ?? ""].join(":");
}

function encodeInvoice(invoice: Invoice): string {
    return `ua://coinpayment/invoice?payload=${encodeURIComponent(btoa(JSON.stringify(serializeInvoice(invoice))))}`;
}

function serializeInvoice(invoice: Invoice) {
    return {
        version: invoice.version,
        amount: invoice.amount,
        receiver: bytesToBase64(invoice.receiver),
        handoff: { kind: invoice.handoff.kind, sssTopic: bytesToBase64(invoice.handoff.sssTopic) },
    };
}

function serializeClearingReference(reference: NonNullable<MerchantPaymentIntent["clearingReference"]>) {
    return {
        root: bytesToBase64(reference.root),
        leaves: reference.leaves.map(([coin, tx]) => [bytesToBase64(coin), bytesToBase64(tx)]),
    };
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function stableHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `0x${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function toMerchantError(error: unknown): MerchantPaymentException {
    if (error instanceof MerchantPaymentException) return error;
    if (error instanceof CoinPaymentException) {
        if (error.code === "userAgentCapabilityUnavailable") return new MerchantPaymentException("userAgentCapabilityUnavailable");
        if (error.code === "purseNotFound") return new MerchantPaymentException("purseUnavailable");
        return new MerchantPaymentException("internal", error.message);
    }
    return new MerchantPaymentException("internal", error instanceof Error ? error.message : String(error));
}
