export {
    CoinPaymentException,
    MAIN_PURSE,
    type Balance,
    type Bytes,
    type Cheque,
    type ClearingReference,
    type CoinPaymentErr,
    type CoinPaymentHostApi,
    type CoinPaymentOperation,
    type CoinPaymentRefundStatus,
    type CoinPaymentStatus,
    type AccountId,
    type CoinagePubKey,
    type Invoice,
    type ListenForResult,
    type MerkleRoot,
    type PaymentBalance,
    type PaymentId,
    type PaymentPurse,
    type PaymentReceipt,
    type PaymentTopUpSource,
    type ProductId,
    type PurseId,
    type PurseInfo,
    type Receivable,
    type StandardTransmissionChannel,
    type Timestamp,
    type TransactionHash,
    type TransmissionChannel,
    type TrUApiCoinPaymentContainer,
    type TrUApiCoinPaymentService,
    type TrUApiPaymentService,
} from "./generated/truapi-coinpayment.js";

import type {
    CoinPaymentHostApi,
    TrUApiCoinPaymentContainer,
} from "./generated/truapi-coinpayment.js";

export interface CoinPaymentWindow {
    truapi?: TrUApiCoinPaymentContainer;
    ua?: {
        truapi?: TrUApiCoinPaymentContainer;
        ext?: {
            coinpayment?: CoinPaymentHostApi;
        };
    };
}
