import {
    CoinPaymentException,
    MAIN_PURSE,
    type Balance,
    type Cheque,
    type ClearingReference,
    type CoinPaymentHostApi,
    type CoinPaymentOperation,
    type CoinPaymentRefundStatus,
    type CoinPaymentStatus,
    type CoinPaymentWindow,
    type Invoice,
    type ListenForResult,
    type PurseId,
    type PurseInfo,
    type Receivable,
    type TransmissionChannel,
} from "./types.js";

interface PurseRecord extends PurseInfo {
    id: PurseId;
}

interface ReceivableRecord {
    id: string;
    bytes: Receivable;
    purse: PurseId;
    deposited?: Cheque;
    refunded?: boolean;
}

interface Listener {
    channel: TransmissionChannel;
    resolve: (cheque: Cheque) => void;
}

export interface CoinPaymentReferenceHost extends CoinPaymentHostApi {
    deliverCheque(channel: TransmissionChannel, cheque: Cheque): void;
    payInvoice(invoice: Invoice, from?: PurseId): Promise<Cheque>;
}

export interface InstallCoinPaymentReferenceHostOptions {
    productId?: ProductIdForReference;
    windowLike?: CoinPaymentWindow;
    initialMainBalance?: Balance;
}

type ProductIdForReference = string;

export function installCoinPaymentReferenceHost(
    options: InstallCoinPaymentReferenceHostOptions = {},
): CoinPaymentReferenceHost {
    const host = new InMemoryCoinPaymentReferenceHost(
        options.productId ?? "reference-product",
        options.initialMainBalance ?? 1_000_000,
    );
    const win = options.windowLike ?? (globalThis.window as CoinPaymentWindow | undefined);
    if (win) {
        win.ua ??= {};
        win.ua.ext ??= {};
        win.ua.ext.coinpayment = host;
    }
    return host;
}

class InMemoryCoinPaymentReferenceHost implements CoinPaymentReferenceHost {
    private readonly purses = new Map<PurseId, PurseRecord>();
    private readonly receivables = new Map<string, ReceivableRecord>();
    private readonly listeners = new Map<string, Listener>();
    private nextPurse = 1;
    private nextSerial = 1;

    constructor(
        private readonly productId: string,
        initialMainBalance: Balance,
    ) {
        this.purses.set(MAIN_PURSE, {
            id: MAIN_PURSE,
            name: "Main purse",
            created: Date.now(),
            creator: "user-agent",
            balance: initialMainBalance,
        });
    }

    async createPurse(name: string): Promise<PurseId> {
        const id = this.nextPurse++;
        this.purses.set(id, { id, name, created: Date.now(), creator: this.productId, balance: 0 });
        return id;
    }

    async queryPurse(purse: PurseId): Promise<PurseInfo> {
        const record = this.requirePurse(purse);
        return {
            name: record.name,
            created: record.created,
            creator: record.creator,
            balance: record.balance,
        };
    }

    async rebalancePurse(
        from: PurseId,
        to: PurseId,
        amount: Balance,
    ): Promise<CoinPaymentOperation<CoinPaymentStatus>> {
        const source = this.requirePurse(from);
        const target = this.requirePurse(to);
        if (source.balance < amount)
            return resolvedOperation(failedStatus("balanceLow", this.makeClearingReference()));
        source.balance -= amount;
        target.balance += amount;
        return clearingOperation(amount, this.makeClearingReference());
    }

    async deletePurse(
        target: PurseId,
        drainInto: PurseId,
    ): Promise<CoinPaymentOperation<CoinPaymentStatus>> {
        if (target === MAIN_PURSE)
            return resolvedOperation(failedStatus("denied", this.makeClearingReference()));
        const source = this.requirePurse(target);
        const destination = this.requirePurse(drainInto);
        const amount = source.balance;
        destination.balance += amount;
        this.purses.delete(target);
        return clearingOperation(amount, this.makeClearingReference());
    }

    async createReceivable(into: PurseId): Promise<Receivable> {
        this.requirePurse(into);
        const bytes = this.bytes(`receivable:${this.nextSerial++}`);
        this.receivables.set(key(bytes), { id: key(bytes), bytes, purse: into });
        return bytes;
    }

    async createCheque(from: PurseId, to: Receivable, amount: Balance): Promise<Cheque> {
        const source = this.requirePurse(from);
        if (!this.receivables.has(key(to))) throw new CoinPaymentException("receivableNotFound");
        if (source.balance < amount) throw new CoinPaymentException("balanceLow");
        source.balance -= amount;
        return {
            version: 0,
            id: new Uint8Array(to),
            amount,
            encryptedSecrets: this.bytes(`cheque:${key(to)}:${amount}:${this.nextSerial++}`),
        };
    }

    async deposit(cheque: Cheque): Promise<CoinPaymentOperation<CoinPaymentStatus>> {
        const receivable = this.requireReceivable(cheque.id);
        const target = this.requirePurse(receivable.purse);
        target.balance += cheque.amount;
        receivable.deposited = cheque;
        return clearingOperation(cheque.amount, this.makeClearingReference());
    }

    async refund(receivable: Receivable): Promise<CoinPaymentOperation<CoinPaymentRefundStatus>> {
        const record = this.requireReceivable(receivable);
        const purse = this.requirePurse(record.purse);
        if (!record.deposited || record.refunded)
            return resolvedOperation(
                failedStatus("receivableNotFound", this.makeClearingReference()),
            );
        if (purse.balance < record.deposited.amount)
            return resolvedOperation(failedStatus("balanceLow", this.makeClearingReference()));
        purse.balance -= record.deposited.amount;
        this.requirePurse(MAIN_PURSE).balance += record.deposited.amount;
        record.refunded = true;
        return clearingOperation(record.deposited.amount, this.makeClearingReference());
    }

    async listenFor(receivable: Receivable): Promise<ListenForResult> {
        this.requireReceivable(receivable);
        const channel = {
            kind: "standard" as const,
            sssTopic: this.bytes(`topic:${key(receivable)}`),
        };
        const cheque = new Promise<Cheque>((resolve) => {
            this.listeners.set(key(channel.sssTopic), { channel, resolve });
        });
        return { channel, cheque };
    }

    async payInvoice(invoice: Invoice, from: PurseId = MAIN_PURSE): Promise<Cheque> {
        const cheque = await this.createCheque(from, invoice.receiver, invoice.amount);
        this.deliverCheque(invoice.handoff, cheque);
        return cheque;
    }

    deliverCheque(channel: TransmissionChannel, cheque: Cheque): void {
        const listener = this.listeners.get(key(channel.sssTopic));
        if (!listener) throw new CoinPaymentException("unsupportedChannel");
        listener.resolve(cheque);
        this.listeners.delete(key(channel.sssTopic));
    }

    private requirePurse(purse: PurseId): PurseRecord {
        const record = this.purses.get(purse);
        if (!record) throw new CoinPaymentException("purseNotFound");
        return record;
    }

    private requireReceivable(receivable: Receivable): ReceivableRecord {
        const record = this.receivables.get(key(receivable));
        if (!record) throw new CoinPaymentException("receivableNotFound");
        return record;
    }

    private makeClearingReference(): ClearingReference {
        return {
            root: this.bytes(`root:${this.nextSerial++}`),
            leaves: [
                [this.bytes(`coin:${this.nextSerial++}`), this.bytes(`tx:${this.nextSerial++}`)],
            ],
        };
    }

    private bytes(value: string): Uint8Array {
        const bytes = new Uint8Array(32);
        bytes.set(new TextEncoder().encode(value).slice(0, 32));
        return bytes;
    }
}

function clearingOperation(
    amount: Balance,
    clearingReference: ClearingReference,
): CoinPaymentOperation<CoinPaymentStatus> {
    const done: CoinPaymentStatus = { kind: "done", cleared: amount, reference: clearingReference };
    return scheduledOperation([{ kind: "clearing", clearing: amount, cleared: 0 }, done], done);
}

function failedStatus(
    error: CoinPaymentException["code"],
    reference: ClearingReference,
): CoinPaymentStatus {
    return { kind: "failed", error, cleared: 0, reference };
}

function resolvedOperation<TStatus>(status: TStatus): CoinPaymentOperation<TStatus> {
    return {
        subscribe(callback) {
            queueMicrotask(() => callback(status));
            return () => {};
        },
        result: Promise.resolve(status),
    };
}

function scheduledOperation<TStatus>(
    statuses: TStatus[],
    result: TStatus,
): CoinPaymentOperation<TStatus> {
    return {
        subscribe(callback) {
            for (const status of statuses) queueMicrotask(() => callback(status));
            return () => {};
        },
        result: Promise.resolve(result),
    };
}

function key(bytes: Uint8Array): string {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    describe("CoinPayment reference host", () => {
        test("pays an invoice into a purse through cheque delivery and deposit", async () => {
            const host = installCoinPaymentReferenceHost({ initialMainBalance: 500 });
            const purse = await host.createPurse("Store");
            const receivable = await host.createReceivable(purse);
            const { channel, cheque } = await host.listenFor(receivable);
            const invoice = {
                version: 0 as const,
                handoff: channel,
                receiver: receivable,
                amount: 125,
            };

            await host.payInvoice(invoice);
            const deposit = await host.deposit(await cheque);
            await expect(deposit.result).resolves.toMatchObject({ kind: "done", cleared: 125 });
            await expect(host.queryPurse(purse)).resolves.toMatchObject({ balance: 125 });
        });

        test("uses the same clearing status shape for refunds", async () => {
            const host = installCoinPaymentReferenceHost({ initialMainBalance: 500 });
            const purse = await host.createPurse("Store");
            const receivable = await host.createReceivable(purse);
            const { channel, cheque } = await host.listenFor(receivable);
            const invoice = {
                version: 0 as const,
                handoff: channel,
                receiver: receivable,
                amount: 125,
            };

            await host.payInvoice(invoice);
            await (await host.deposit(await cheque)).result;
            const refund = await host.refund(receivable);

            await expect(refund.result).resolves.toMatchObject({ kind: "done", cleared: 125 });
        });
    });
}
