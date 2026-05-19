import {
    CoinPaymentException,
    MAIN_PURSE,
    type Balance,
    type Cheque,
    type ClearingReference,
    type CoinPaymentErr,
    type CoinPaymentHostApi,
    type CoinPaymentOperation,
    type CoinPaymentRefundStatus,
    type CoinPaymentStatus,
    type Invoice,
    type ListenForResult,
    type PaymentBalance,
    type PaymentPurse,
    type PaymentReceipt,
    type PaymentTopUpSource,
    type PurseId,
    type PurseInfo,
    type Receivable,
    type StandardTransmissionChannel,
    type TransmissionChannel,
} from "./types.js";

type BytesLike = Uint8Array | number[] | string;

interface WasmCheque {
    version: number;
    id: BytesLike;
    amount: Balance;
    encryptedSecrets?: BytesLike;
    encrypted_secrets?: BytesLike;
}

interface WasmClearingReference {
    root: BytesLike;
    leaves: Array<[BytesLike, BytesLike]>;
}

interface WasmSettlementProgress {
    clearing: Balance;
    cleared: Balance;
}

interface WasmSettlementTerminal {
    kind?: string;
    state?: string;
    error?: CoinPaymentErr;
    cleared: Balance;
    reference: WasmClearingReference;
}

interface WasmSettlementReceipt {
    progress?: WasmSettlementProgress[];
    terminal: WasmSettlementTerminal;
}

interface WasmTransmissionChannel {
    kind?: string;
    Standard?: { sssTopic?: BytesLike; sss_topic?: BytesLike };
    sssTopic?: BytesLike;
    sss_topic?: BytesLike;
}

interface WasmListenForSession {
    channel: WasmTransmissionChannel;
}

export interface CoinageProductionPaymentRuntimeLike {
    createPurse(productId: string, name: string): Promise<PurseId>;
    queryPurse(purse: PurseId): Promise<PurseInfo>;
    rebalancePurse(from: PurseId, to: PurseId, amount: Balance): Promise<WasmSettlementReceipt>;
    deletePurse(target: PurseId, drainInto: PurseId): Promise<WasmSettlementReceipt>;
    createReceivable(into: PurseId): Promise<Receivable>;
    listenFor(receivable: Receivable): Promise<WasmListenForSession>;
    invoiceFor(receiver: Receivable, amount: Balance): Promise<Invoice>;
    createCheque(from: PurseId, to: Receivable, amount: Balance): Promise<WasmCheque>;
    deposit(cheque: WasmCheque): Promise<WasmSettlementReceipt>;
    refund(receivable: Receivable): Promise<WasmSettlementReceipt>;
    paymentBalance(purse?: PaymentPurse): Promise<PaymentBalance>;
    paymentTopUpProductAccount(
        into: PaymentPurse,
        amount: Balance,
        derivationIndex: number,
    ): Promise<WasmSettlementReceipt>;
    paymentTopUpPrivateKey(
        into: PaymentPurse,
        amount: Balance,
        privateKey: Uint8Array,
    ): Promise<WasmSettlementReceipt>;
    paymentRequest(
        from: PaymentPurse,
        amount: Balance,
        destination: Uint8Array,
    ): Promise<PaymentReceipt>;
    recover?(deepScan: boolean): Promise<unknown>;
}

export interface CoinageProductionPaymentRuntimeConstructor {
    new (adapters: CoinageProductionRuntimeAdapters): CoinageProductionPaymentRuntimeLike;
}

export interface CoinageProductionRuntimeModule {
    CoinageProductionPaymentRuntime: CoinageProductionPaymentRuntimeConstructor;
}

export interface CoinageProductionRuntimeAdapters {
    inventory: unknown;
    chequeCrypto: unknown;
    settlementFinality: unknown;
    statementStore: unknown;
    topUp: unknown;
    recovery?: unknown;
}

export interface CoinageProductionChequeInbox {
    waitForCheque(receivable: Receivable, channel: TransmissionChannel): Promise<Cheque>;
}

export interface CreateCoinageProductionHostOptions {
    productId?: string;
    runtime?: CoinageProductionPaymentRuntimeLike;
    runtimeModule?: CoinageProductionRuntimeModule;
    adapters?: CoinageProductionRuntimeAdapters;
    chequeInbox: CoinageProductionChequeInbox;
}

export function createCoinageProductionHost(
    options: CreateCoinageProductionHostOptions,
): CoinPaymentHostApi {
    const productId = options.productId ?? "product-sdk-pwa";
    const runtime = resolveRuntime(options);
    const chequeInbox = options.chequeInbox;

    return {
        createPurse(name) {
            return runtime.createPurse(productId, name);
        },
        queryPurse(purse) {
            return runtime.queryPurse(purse);
        },
        async rebalancePurse(from, to, amount) {
            return operationFromReceipt(await runtime.rebalancePurse(from, to, amount));
        },
        async deletePurse(target, drainInto) {
            return operationFromReceipt(await runtime.deletePurse(target, drainInto));
        },
        async createReceivable(into) {
            return bytesFrom(await runtime.createReceivable(into));
        },
        async createCheque(from, to, amount) {
            return chequeFromWasm(await runtime.createCheque(from, to, amount));
        },
        async deposit(cheque) {
            return operationFromReceipt(await runtime.deposit(chequeToWasm(cheque)));
        },
        async refund(receivable) {
            return operationFromReceipt<CoinPaymentRefundStatus>(await runtime.refund(receivable));
        },
        async listenFor(receivable) {
            const session = await runtime.listenFor(receivable);
            const channel = channelFromWasm(session.channel);
            return {
                channel,
                cheque: chequeInbox.waitForCheque(receivable, channel),
            };
        },
        paymentBalance(purse) {
            return runtime.paymentBalance(purse);
        },
        async paymentTopUp(into, amount, source) {
            const receipt =
                source.kind === "productAccount"
                    ? await runtime.paymentTopUpProductAccount(into, amount, source.derivationIndex)
                    : await runtime.paymentTopUpPrivateKey(into, amount, source.secret);
            return operationFromReceipt(receipt);
        },
        async paymentRequest(from, amount, destination) {
            return runtime.paymentRequest(from, amount, destination);
        },
    };
}

function resolveRuntime(
    options: CreateCoinageProductionHostOptions,
): CoinageProductionPaymentRuntimeLike {
    if (options.runtime) return options.runtime;
    const Runtime = options.runtimeModule?.CoinageProductionPaymentRuntime;
    if (!Runtime || !options.adapters) {
        throw new CoinPaymentException(
            "userAgentCapabilityUnavailable",
            "Coinage production runtime and adapters are required",
        );
    }
    return new Runtime(options.adapters);
}

function operationFromReceipt<TStatus extends CoinPaymentStatus>(
    receipt: WasmSettlementReceipt,
): CoinPaymentOperation<TStatus> {
    const statuses = statusesFromReceipt(receipt) as TStatus[];
    const result = statuses[statuses.length - 1];
    return {
        subscribe(callback) {
            for (const status of statuses) queueMicrotask(() => callback(status));
            return () => {};
        },
        result: Promise.resolve(result),
    };
}

function statusesFromReceipt(receipt: WasmSettlementReceipt): CoinPaymentStatus[] {
    const progress = (receipt.progress ?? []).map<CoinPaymentStatus>((item) => ({
        kind: "clearing",
        clearing: item.clearing,
        cleared: item.cleared,
    }));
    const terminalKind = receipt.terminal.kind ?? receipt.terminal.state;
    const terminal =
        terminalKind === "failed"
            ? {
                  kind: "failed" as const,
                  error: receipt.terminal.error ?? "internal",
                  cleared: receipt.terminal.cleared,
                  reference: referenceFromWasm(receipt.terminal.reference),
              }
            : {
                  kind: "done" as const,
                  cleared: receipt.terminal.cleared,
                  reference: referenceFromWasm(receipt.terminal.reference),
              };
    return [...progress, terminal];
}

function chequeFromWasm(cheque: WasmCheque): Cheque {
    if (cheque.version !== 0) {
        throw new CoinPaymentException("badCoins", "unsupported cheque version");
    }
    return {
        version: 0,
        id: bytesFrom(cheque.id),
        amount: cheque.amount,
        encryptedSecrets: bytesFrom(cheque.encryptedSecrets ?? cheque.encrypted_secrets),
    };
}

function chequeToWasm(cheque: Cheque): WasmCheque {
    return {
        version: cheque.version,
        id: cheque.id,
        amount: cheque.amount,
        encryptedSecrets: cheque.encryptedSecrets,
        encrypted_secrets: cheque.encryptedSecrets,
    };
}

function channelFromWasm(channel: WasmTransmissionChannel): TransmissionChannel {
    const standard = channel.Standard ?? channel;
    const topic = standard.sssTopic ?? standard.sss_topic;
    if ((channel.kind ?? "standard") !== "standard" || !topic) {
        throw new CoinPaymentException("unsupportedChannel");
    }
    return {
        kind: "standard",
        sssTopic: bytesFrom(topic),
    } satisfies StandardTransmissionChannel;
}

function referenceFromWasm(reference: WasmClearingReference): ClearingReference {
    return {
        root: bytesFrom(reference.root),
        leaves: reference.leaves.map(([coin, tx]) => [bytesFrom(coin), bytesFrom(tx)]),
    };
}

function bytesFrom(value: BytesLike | Promise<BytesLike> | undefined): Uint8Array {
    if (!value) throw new CoinPaymentException("internal", "missing byte field");
    if (value instanceof Promise) {
        throw new CoinPaymentException("internal", "unexpected async byte field");
    }
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value);
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (hex.length % 2 !== 0) throw new CoinPaymentException("internal", "invalid hex bytes");
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;

    describe("Coinage production host", () => {
        test("adapts the production WASM runtime into the CoinPayment host API", async () => {
            const receivable = bytes("receivable");
            const cheque: Cheque = {
                version: 0,
                id: receivable,
                amount: 125,
                encryptedSecrets: bytes("encrypted"),
            };
            const runtime: CoinageProductionPaymentRuntimeLike = {
                createPurse: vi.fn(async () => 7),
                queryPurse: vi.fn(async () => ({
                    name: "Store",
                    created: 1,
                    creator: "test",
                    balance: 0,
                })),
                rebalancePurse: vi.fn(async () => doneReceipt(125)),
                deletePurse: vi.fn(async () => doneReceipt(0)),
                createReceivable: vi.fn(async () => receivable),
                listenFor: vi.fn(async () => ({
                    channel: { kind: "standard", sss_topic: bytes("topic") },
                })),
                invoiceFor: vi.fn(async () => ({
                    version: 0 as const,
                    handoff: { kind: "standard" as const, sssTopic: bytes("topic") },
                    receiver: receivable,
                    amount: 125,
                })),
                createCheque: vi.fn(async () => ({
                    version: 0,
                    id: receivable,
                    amount: 125,
                    encrypted_secrets: bytes("encrypted"),
                })),
                deposit: vi.fn(async () => doneReceipt(125)),
                refund: vi.fn(async () => doneReceipt(125)),
                paymentBalance: vi.fn(async () => ({ available: 500 })),
                paymentTopUpProductAccount: vi.fn(async () => doneReceipt(25)),
                paymentTopUpPrivateKey: vi.fn(async () => doneReceipt(25)),
                paymentRequest: vi.fn(async () => ({
                    id: "payment:1",
                    reference: reference(),
                })),
            };
            const host = createCoinageProductionHost({
                runtime,
                chequeInbox: {
                    waitForCheque: vi.fn(async () => cheque),
                },
            });

            await expect(host.createPurse("Store")).resolves.toBe(7);
            await expect(host.createReceivable(7)).resolves.toEqual(receivable);
            const listen = await host.listenFor(receivable);
            await expect(listen.cheque).resolves.toEqual(cheque);
            await expect(host.createCheque(MAIN_PURSE, receivable, 125)).resolves.toEqual(cheque);
            await expect((await host.deposit(cheque)).result).resolves.toMatchObject({
                kind: "done",
                cleared: 125,
            });
        });
    });

    function doneReceipt(cleared: Balance): WasmSettlementReceipt {
        return {
            progress: [{ clearing: cleared, cleared: 0 }],
            terminal: { kind: "done", cleared, reference: reference() },
        };
    }

    function reference(): ClearingReference {
        return {
            root: bytes("root"),
            leaves: [[bytes("coin"), bytes("tx")]],
        };
    }

    function bytes(seed: string): Uint8Array {
        const output = new Uint8Array(32);
        output.set(new TextEncoder().encode(seed).slice(0, 32));
        return output;
    }
}
