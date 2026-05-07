export type PurseId = number;
export const MAIN_PURSE: PurseId = 0xffffffff;

export type Balance = number;
export type Timestamp = number;
export type ProductId = string;
export type Bytes = Uint8Array;
export type MerkleRoot = Bytes;
export type TransactionHash = Bytes;
export type CoinagePubKey = Bytes;

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

export type Receivable = Bytes;

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
    | { kind: "failed"; error: CoinPaymentErr }
    | { kind: "clearing"; clearing: Balance; cleared: Balance }
    | { kind: "done"; clearingReference: ClearingReference };

export type CoinPaymentRefundStatus =
    | { kind: "failed" }
    | { kind: "refunding"; clearing: Balance; cleared: Balance }
    | { kind: "done"; clearingReference: ClearingReference };

export interface CoinPaymentOperation<TStatus> {
    subscribe(callback: (status: TStatus) => void, onError?: (error: CoinPaymentException) => void): () => void;
    result: Promise<TStatus>;
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
    createInvoice?(into: PurseId, amount: Balance): Promise<Invoice>;
    createReceivable(into: PurseId): Promise<Receivable>;
    createCheque(from: PurseId, to: Receivable, amount: Balance): Promise<Cheque>;
    deposit(cheque: Cheque): Promise<CoinPaymentOperation<CoinPaymentStatus>>;
    refund(receivable: Receivable): Promise<CoinPaymentOperation<CoinPaymentRefundStatus>>;
    listenFor(receivable: Receivable): Promise<ListenForResult>;
}

export interface CoinPaymentWindow {
    ua?: {
        ext?: {
            coinpayment?: CoinPaymentHostApi;
        };
    };
}
