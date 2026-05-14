// Generated-style RFC 0017 protocol bindings.
//
// Keep this module as the narrow host contract. Hand-written SDK clients and
// adapters should wrap these types rather than redefining them.

export type PurseId = number;
export const MAIN_PURSE: PurseId = 0xffffffff;

export type Balance = number;
export type Timestamp = number;
export type ProductId = string;
export type Bytes = Uint8Array;
export type MerkleRoot = Bytes;
export type TransactionHash = Bytes;
export type CoinagePubKey = Bytes;
export type Receivable = Bytes;
export type AccountId = Bytes;
export type PaymentId = string;
export type PaymentPurse = PurseId | undefined;

export interface PurseInfo {
    name: string;
    created: Timestamp;
    creator: ProductId;
    balance: Balance;
}

export interface Cheque {
    version: 0;
    id: Receivable;
    amount: Balance;
    encryptedSecrets: Bytes;
}

export type CoinPaymentErr =
    | "balanceLow"
    | "denied"
    | "badCoins"
    | "snipedCoins"
    | "purseNotFound"
    | "receivableNotFound"
    | "unsupportedChannel"
    | "userAgentCapabilityUnavailable"
    | "internal";

export class CoinPaymentException extends Error {
    constructor(
        readonly code: CoinPaymentErr,
        message: string = code,
    ) {
        super(message);
        this.name = "CoinPaymentException";
    }
}

export interface ClearingReference {
    root: MerkleRoot;
    leaves: Array<[CoinagePubKey, TransactionHash]>;
}

export type CoinPaymentStatus =
    | { kind: "failed"; error: CoinPaymentErr; cleared: Balance; reference: ClearingReference }
    | { kind: "clearing"; clearing: Balance; cleared: Balance }
    | { kind: "done"; cleared: Balance; reference: ClearingReference };

export type CoinPaymentRefundStatus = CoinPaymentStatus;

export interface CoinPaymentOperation<TStatus> {
    subscribe(callback: (status: TStatus) => void, onError?: (error: CoinPaymentException) => void): () => void;
    result: Promise<TStatus>;
}

export interface PaymentBalance {
    available: Balance;
}

export type PaymentTopUpSource =
    | { kind: "productAccount"; derivationIndex: number }
    | { kind: "privateKey"; secret: Bytes };

export interface PaymentReceipt {
    id: PaymentId;
}

export interface StandardTransmissionChannel {
    kind: "standard";
    sssTopic: Bytes;
}

export type TransmissionChannel = StandardTransmissionChannel;

export interface Invoice {
    version: 0;
    handoff: TransmissionChannel;
    receiver: Receivable;
    amount: Balance;
}

export interface ListenForResult {
    channel: TransmissionChannel;
    cheque: Promise<Cheque>;
}

export interface CoinPaymentHostApi {
    createPurse(name: string): Promise<PurseId>;
    queryPurse(purse: PurseId): Promise<PurseInfo>;
    rebalancePurse(from: PurseId, to: PurseId, amount: Balance): Promise<CoinPaymentOperation<CoinPaymentStatus>>;
    deletePurse(target: PurseId, drainInto: PurseId): Promise<CoinPaymentOperation<CoinPaymentStatus>>;
    createReceivable(into: PurseId): Promise<Receivable>;
    createCheque(from: PurseId, to: Receivable, amount: Balance): Promise<Cheque>;
    deposit(cheque: Cheque): Promise<CoinPaymentOperation<CoinPaymentStatus>>;
    refund(receivable: Receivable): Promise<CoinPaymentOperation<CoinPaymentRefundStatus>>;
    listenFor(receivable: Receivable): Promise<ListenForResult>;
    paymentBalance(purse?: PaymentPurse): Promise<PaymentBalance>;
    paymentTopUp(into: PaymentPurse, amount: Balance, source: PaymentTopUpSource): Promise<CoinPaymentOperation<CoinPaymentStatus>>;
    paymentRequest(from: PaymentPurse, amount: Balance, destination: AccountId): Promise<PaymentReceipt>;
}

export interface TrUApiResult<TValue, TError> {
    isOk?: () => boolean;
    isErr?: () => boolean;
    value?: TValue;
    error?: TError;
    success?: boolean;
}

export interface TrUApiObservable<TItem, TError> {
    subscribe(observer: {
        next?: (item: TItem) => void;
        error?: (error: unknown) => void;
        complete?: () => void;
    }): { unsubscribe(): void } | (() => void);
}

export interface TrUApiCoinPaymentService {
    coinPaymentCreatePurse(request: { name: string }): Promise<TrUApiResult<{ purse: PurseId }, TrUApiCoinPaymentError>>;
    coinPaymentQueryPurse(request: { purse: PurseId }): Promise<TrUApiResult<{ info: PurseInfo }, TrUApiCoinPaymentError>>;
    coinPaymentRebalancePurse(input: { request: { from: PurseId; to: PurseId; amount: Balance } }): TrUApiObservable<TrUApiCoinPaymentStatus, TrUApiCoinPaymentError>;
    coinPaymentDeletePurse(input: { request: { target: PurseId; drainInto: PurseId } }): TrUApiObservable<TrUApiCoinPaymentStatus, TrUApiCoinPaymentError>;
    coinPaymentCreateReceivable(request: { into: PurseId }): Promise<TrUApiResult<{ receivable: TrUApiBytes }, TrUApiCoinPaymentError>>;
    coinPaymentCreateCheque(request: { from: PurseId; to: TrUApiBytes; amount: Balance }): Promise<TrUApiResult<{ cheque: TrUApiCheque }, TrUApiCoinPaymentError>>;
    coinPaymentDeposit(input: { request: { cheque: TrUApiCheque } }): TrUApiObservable<TrUApiCoinPaymentStatus, TrUApiCoinPaymentError>;
    coinPaymentRefund(input: { request: { receivable: TrUApiBytes } }): TrUApiObservable<TrUApiCoinPaymentStatus, TrUApiCoinPaymentError>;
    coinPaymentListenFor(input: { request: { receivable: TrUApiBytes } }): TrUApiObservable<TrUApiListenForItem, TrUApiCoinPaymentError>;
}

export interface TrUApiCoinPaymentContainer {
    coinPayment?: TrUApiCoinPaymentService;
    payment?: TrUApiPaymentService;
}

export type TrUApiBytes = string | Uint8Array | number[];

export interface TrUApiCheque {
    version: number;
    id: TrUApiBytes;
    amount: Balance;
    encryptedSecrets: TrUApiBytes;
}

export type TrUApiCoinPaymentError =
    | { tag: "BalanceLow"; value?: undefined }
    | { tag: "Denied"; value?: undefined }
    | { tag: "BadCoins"; value?: undefined }
    | { tag: "SnipedCoins"; value?: undefined }
    | { tag: "PurseNotFound"; value?: undefined }
    | { tag: "ReceivableNotFound"; value?: undefined }
    | { tag: "UnsupportedChannel"; value?: undefined }
    | { tag: "UserAgentCapabilityUnavailable"; value?: undefined }
    | { tag: "Internal"; value?: undefined };

export type TrUApiCoinPaymentStatus =
    | { tag: "Failed"; value: { error: TrUApiCoinPaymentError; cleared: Balance; reference: TrUApiClearingReference } }
    | { tag: "Clearing"; value: { clearing: Balance; cleared: Balance } }
    | { tag: "Done"; value: { cleared: Balance; reference: TrUApiClearingReference } };

export interface TrUApiClearingReference {
    root: TrUApiBytes;
    leaves: Array<[TrUApiBytes, TrUApiBytes]>;
}

export type TrUApiTransmissionChannel = { tag: "Standard"; value: { sssTopic: TrUApiBytes } };

export type TrUApiListenForItem =
    | { tag: "Channel"; value: TrUApiTransmissionChannel }
    | { tag: "Cheque"; value: TrUApiCheque };

export interface TrUApiPaymentService {
    paymentBalanceSubscribe(input: { request: { purse?: PurseId } }): TrUApiObservable<PaymentBalance, TrUApiPaymentError>;
    paymentTopUp(request: { into?: PurseId; amount: Balance; source: TrUApiPaymentTopUpSource }): Promise<TrUApiResult<undefined, TrUApiPaymentError>>;
    paymentRequest(request: { from?: PurseId; amount: Balance; destination: TrUApiBytes }): Promise<TrUApiResult<PaymentReceipt, TrUApiPaymentError>>;
}

export type TrUApiPaymentTopUpSource =
    | { tag: "ProductAccount"; value: { derivationIndex: number } }
    | { tag: "PrivateKey"; value: { ed25519PrivateKey: TrUApiBytes } };

export type TrUApiPaymentError =
    | { tag: "PermissionDenied"; value?: undefined }
    | { tag: "InsufficientFunds"; value?: undefined }
    | { tag: "InvalidSource"; value?: undefined }
    | { tag: "Rejected"; value?: undefined }
    | { tag: "InsufficientBalance"; value?: undefined }
    | { tag: "Unknown"; value?: { reason: string } };
