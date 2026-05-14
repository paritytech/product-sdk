import { getTruApi } from "@parity/product-sdk-host";
import {
    CoinPaymentException,
    type Balance,
    type Cheque,
    type ClearingReference,
    type CoinPaymentErr,
    type CoinPaymentHostApi,
    type CoinPaymentOperation,
    type CoinPaymentStatus,
    type CoinPaymentWindow,
    type ListenForResult,
    type PaymentBalance,
    type PaymentPurse,
    type PaymentReceipt,
    type PaymentTopUpSource,
    type PurseId,
    type Receivable,
    type TransmissionChannel,
    type TrUApiCoinPaymentContainer,
    type TrUApiCoinPaymentService,
    type TrUApiPaymentService,
} from "./types.js";
import type {
    TrUApiBytes,
    TrUApiCheque,
    TrUApiClearingReference,
    TrUApiCoinPaymentError,
    TrUApiCoinPaymentStatus,
    TrUApiListenForItem,
    TrUApiObservable,
    TrUApiPaymentError,
    TrUApiPaymentTopUpSource,
    TrUApiResult,
    TrUApiTransmissionChannel,
} from "./generated/truapi-coinpayment.js";

export interface CreateCoinPaymentClientOptions {
    host?: CoinPaymentHostApi;
    truapi?: TrUApiCoinPaymentContainer | TrUApiCoinPaymentService;
    windowLike?: CoinPaymentWindow;
}

export function createCoinPaymentClient(
    options: CreateCoinPaymentClientOptions = {},
): CoinPaymentHostApi {
    const host =
        options.host ?? resolveTruApiHost(options.truapi) ?? resolveHost(options.windowLike);
    if (!host)
        throw new CoinPaymentException(
            "userAgentCapabilityUnavailable",
            "CoinPayment user-agent API is unavailable",
        );
    return host;
}

export async function createCoinPaymentClientFromHost(): Promise<CoinPaymentHostApi> {
    return createCoinPaymentClient({ truapi: (await getTruApi()) ?? undefined });
}

function resolveHost(
    windowLike = globalThis.window as CoinPaymentWindow | undefined,
): CoinPaymentHostApi | undefined {
    return (
        resolveTruApiHost(windowLike?.truapi) ??
        resolveTruApiHost(windowLike?.ua?.truapi) ??
        windowLike?.ua?.ext?.coinpayment
    );
}

function resolveTruApiHost(
    candidate?: TrUApiCoinPaymentContainer | TrUApiCoinPaymentService | null,
): CoinPaymentHostApi | undefined {
    if (!candidate) return undefined;
    const service = isCoinPaymentService(candidate) ? candidate : candidate.coinPayment;
    const payment = isCoinPaymentService(candidate) ? undefined : candidate.payment;
    return service ? createTruApiCoinPaymentAdapter(service, payment) : undefined;
}

function isCoinPaymentService(
    candidate: TrUApiCoinPaymentContainer | TrUApiCoinPaymentService,
): candidate is TrUApiCoinPaymentService {
    return "coinPaymentCreatePurse" in candidate;
}

function createTruApiCoinPaymentAdapter(
    service: TrUApiCoinPaymentService,
    payment?: TrUApiPaymentService,
): CoinPaymentHostApi {
    return {
        async createPurse(name) {
            return unwrapResult(await service.coinPaymentCreatePurse({ name })).purse;
        },
        async queryPurse(purse) {
            return unwrapResult(await service.coinPaymentQueryPurse({ purse })).info;
        },
        async rebalancePurse(from, to, amount) {
            return operationFromObservable(
                service.coinPaymentRebalancePurse({ request: { from, to, amount } }),
            );
        },
        async deletePurse(target, drainInto) {
            return operationFromObservable(
                service.coinPaymentDeletePurse({ request: { target, drainInto } }),
            );
        },
        async createReceivable(into) {
            return bytesFromTruApi(
                unwrapResult(await service.coinPaymentCreateReceivable({ into })).receivable,
            );
        },
        async createCheque(from, to, amount) {
            return chequeFromTruApi(
                unwrapResult(
                    await service.coinPaymentCreateCheque({
                        from,
                        to: bytesToTruApi(to),
                        amount,
                    }),
                ).cheque,
            );
        },
        async deposit(cheque) {
            return operationFromObservable(
                service.coinPaymentDeposit({ request: { cheque: chequeToTruApi(cheque) } }),
            );
        },
        async refund(receivable) {
            return operationFromObservable(
                service.coinPaymentRefund({ request: { receivable: bytesToTruApi(receivable) } }),
            );
        },
        async listenFor(receivable) {
            return listenForFromObservable(
                service.coinPaymentListenFor({
                    request: { receivable: bytesToTruApi(receivable) },
                }),
            );
        },
        async paymentBalance(purse?: PaymentPurse) {
            return firstFromObservable(
                requirePayment(payment).paymentBalanceSubscribe({
                    request: purse === undefined ? {} : { purse },
                }),
            );
        },
        async paymentTopUp(into, amount, source) {
            unwrapResult(
                await requirePayment(payment).paymentTopUp({
                    ...(into === undefined ? {} : { into }),
                    amount,
                    source: paymentTopUpSourceToTruApi(source),
                }),
            );
            return resolvedOperation({
                kind: "done",
                cleared: amount,
                reference: emptyReference(),
            });
        },
        async paymentRequest(from, amount, destination) {
            return unwrapResult(
                await requirePayment(payment).paymentRequest({
                    ...(from === undefined ? {} : { from }),
                    amount,
                    destination: bytesToTruApi(destination),
                }),
            );
        },
    };
}

function requirePayment(payment: TrUApiPaymentService | undefined): TrUApiPaymentService {
    if (!payment) {
        throw new CoinPaymentException(
            "userAgentCapabilityUnavailable",
            "TrUAPI payment service is unavailable",
        );
    }
    return payment;
}

function unwrapResult<TValue, TError>(result: TrUApiResult<TValue, TError>): TValue {
    if (result.isErr?.() || result.success === false) {
        throw exceptionFromTruApiError(result.error);
    }
    if (result.isOk?.() || result.success === true || "value" in result) {
        return result.value as TValue;
    }
    throw new CoinPaymentException("internal", "Malformed CoinPayment result");
}

function operationFromObservable(
    observable: TrUApiObservable<TrUApiCoinPaymentStatus, TrUApiCoinPaymentError>,
): CoinPaymentOperation<CoinPaymentStatus> {
    let lastStatus: CoinPaymentStatus | undefined;
    let settled = false;
    const subscription: { value?: TrUApiSubscription } = {};
    const result = new Promise<CoinPaymentStatus>((resolve, reject) => {
        subscription.value = observable.subscribe({
            next(item) {
                const status = statusFromTruApi(item);
                lastStatus = status;
                if (status.kind === "done" || status.kind === "failed") {
                    settled = true;
                    resolve(status);
                    unsubscribeFromTruApi(subscription.value);
                }
            },
            error(error) {
                if (!settled) reject(toCoinPaymentException(error));
            },
            complete() {
                if (!settled && lastStatus) resolve(lastStatus);
            },
        });
    });
    return {
        subscribe(callback, onError) {
            const subscription = observable.subscribe({
                next: (item) => callback(statusFromTruApi(item)),
                error: (error) => onError?.(toCoinPaymentException(error)),
            });
            return () => unsubscribeFromTruApi(subscription);
        },
        result,
    };
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

function firstFromObservable<TItem, TError>(
    observable: TrUApiObservable<TItem, TError>,
): Promise<TItem> {
    return new Promise<TItem>((resolve, reject) => {
        const subscription: { value?: TrUApiSubscription } = {};
        subscription.value = observable.subscribe({
            next(item) {
                resolve(item);
                unsubscribeFromTruApi(subscription.value);
            },
            error: (error) => reject(toCoinPaymentException(error)),
        });
    });
}

async function listenForFromObservable(
    observable: TrUApiObservable<TrUApiListenForItem, TrUApiCoinPaymentError>,
): Promise<ListenForResult> {
    let channelSettled = false;
    let chequeSettled = false;
    let resolveChannel: (channel: TransmissionChannel) => void = () => {};
    let rejectChannel: (error: CoinPaymentException) => void = () => {};
    let resolveCheque: (cheque: Cheque) => void = () => {};
    let rejectCheque: (error: CoinPaymentException) => void = () => {};
    const subscription: { value?: TrUApiSubscription } = {};
    const channel = new Promise<TransmissionChannel>((resolve, reject) => {
        resolveChannel = resolve;
        rejectChannel = reject;
    });
    const cheque = new Promise<Cheque>((resolve, reject) => {
        resolveCheque = resolve;
        rejectCheque = reject;
    });
    subscription.value = observable.subscribe({
        next(item) {
            if (item.tag === "Channel" && !channelSettled) {
                channelSettled = true;
                resolveChannel(channelFromTruApi(item.value));
                return;
            }
            if (item.tag === "Cheque" && !chequeSettled) {
                chequeSettled = true;
                resolveCheque(chequeFromTruApi(item.value));
                unsubscribeFromTruApi(subscription.value);
            }
        },
        error(error) {
            const exception = toCoinPaymentException(error);
            if (!channelSettled) rejectChannel(exception);
            if (!chequeSettled) rejectCheque(exception);
        },
        complete() {
            const exception = new CoinPaymentException(
                "internal",
                "CoinPayment listener completed before cheque",
            );
            if (!channelSettled) rejectChannel(exception);
            if (!chequeSettled) rejectCheque(exception);
        },
    });
    return { channel: await channel, cheque };
}

type TrUApiSubscription = { unsubscribe(): void } | (() => void);

function unsubscribeFromTruApi(subscription: TrUApiSubscription | undefined): void {
    if (!subscription) return;
    if (typeof subscription === "function") {
        subscription();
        return;
    }
    subscription.unsubscribe();
}

function statusFromTruApi(status: TrUApiCoinPaymentStatus): CoinPaymentStatus {
    switch (status.tag) {
        case "Clearing":
            return { kind: "clearing", ...status.value };
        case "Done":
            return {
                kind: "done",
                cleared: status.value.cleared,
                reference: clearingReferenceFromTruApi(status.value.reference),
            };
        case "Failed":
            return {
                kind: "failed",
                error: errorCodeFromTruApi(status.value.error),
                cleared: status.value.cleared,
                reference: clearingReferenceFromTruApi(status.value.reference),
            };
    }
}

function chequeFromTruApi(cheque: TrUApiCheque): Cheque {
    return {
        version: 0,
        id: bytesFromTruApi(cheque.id),
        amount: cheque.amount,
        encryptedSecrets: bytesFromTruApi(cheque.encryptedSecrets),
    };
}

function chequeToTruApi(cheque: Cheque): TrUApiCheque {
    return {
        version: cheque.version,
        id: bytesToTruApi(cheque.id),
        amount: cheque.amount,
        encryptedSecrets: bytesToTruApi(cheque.encryptedSecrets),
    };
}

function channelFromTruApi(channel: TrUApiTransmissionChannel): TransmissionChannel {
    if (channel.tag !== "Standard") throw new CoinPaymentException("unsupportedChannel");
    return { kind: "standard", sssTopic: bytesFromTruApi(channel.value.sssTopic) };
}

function clearingReferenceFromTruApi(reference: TrUApiClearingReference): ClearingReference {
    return {
        root: bytesFromTruApi(reference.root),
        leaves: reference.leaves.map(([coin, tx]) => [bytesFromTruApi(coin), bytesFromTruApi(tx)]),
    };
}

function errorCodeFromTruApi(error: TrUApiCoinPaymentError | undefined): CoinPaymentErr {
    switch (error?.tag) {
        case "BalanceLow":
            return "balanceLow";
        case "Denied":
            return "denied";
        case "BadCoins":
            return "badCoins";
        case "SnipedCoins":
            return "snipedCoins";
        case "PurseNotFound":
            return "purseNotFound";
        case "ReceivableNotFound":
            return "receivableNotFound";
        case "UnsupportedChannel":
            return "unsupportedChannel";
        case "UserAgentCapabilityUnavailable":
            return "userAgentCapabilityUnavailable";
        default:
            return "internal";
    }
}

function errorCodeFromPayment(error: TrUApiPaymentError | undefined): CoinPaymentErr {
    switch (error?.tag) {
        case "InsufficientFunds":
        case "InsufficientBalance":
            return "balanceLow";
        case "PermissionDenied":
        case "Rejected":
        case "InvalidSource":
            return "denied";
        default:
            return "internal";
    }
}

function exceptionFromTruApiError(error: unknown): CoinPaymentException {
    if (isTruApiCoinPaymentError(error))
        return new CoinPaymentException(errorCodeFromTruApi(error));
    if (isTrUApiPaymentError(error)) return new CoinPaymentException(errorCodeFromPayment(error));
    return toCoinPaymentException(error);
}

function toCoinPaymentException(error: unknown): CoinPaymentException {
    if (error instanceof CoinPaymentException) return error;
    const reason = error instanceof Error ? error.message : String(error);
    return new CoinPaymentException("internal", reason);
}

function isTruApiCoinPaymentError(error: unknown): error is TrUApiCoinPaymentError {
    if (!error || typeof error !== "object" || !("tag" in error)) return false;
    return [
        "BalanceLow",
        "Denied",
        "BadCoins",
        "SnipedCoins",
        "PurseNotFound",
        "ReceivableNotFound",
        "UnsupportedChannel",
        "UserAgentCapabilityUnavailable",
        "Internal",
    ].includes(String(error.tag));
}

function isTrUApiPaymentError(error: unknown): error is TrUApiPaymentError {
    if (!error || typeof error !== "object" || !("tag" in error)) return false;
    return [
        "PermissionDenied",
        "InsufficientFunds",
        "InvalidSource",
        "Rejected",
        "InsufficientBalance",
        "Unknown",
    ].includes(String(error.tag));
}

function paymentTopUpSourceToTruApi(source: PaymentTopUpSource): TrUApiPaymentTopUpSource {
    if (source.kind === "productAccount") {
        return { tag: "ProductAccount", value: { derivationIndex: source.derivationIndex } };
    }
    return { tag: "PrivateKey", value: { ed25519PrivateKey: bytesToTruApi(source.secret) } };
}

function emptyReference(): ClearingReference {
    return { root: new Uint8Array(32), leaves: [] };
}

function bytesToTruApi(bytes: Uint8Array): string {
    return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function bytesFromTruApi(bytes: TrUApiBytes): Uint8Array {
    if (bytes instanceof Uint8Array) return bytes;
    if (Array.isArray(bytes)) return new Uint8Array(bytes);
    const hex = bytes.startsWith("0x") ? bytes.slice(2) : bytes;
    const out = new Uint8Array(hex.length / 2);
    for (let index = 0; index < out.length; index += 1) {
        out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
}
