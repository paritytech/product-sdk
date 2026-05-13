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
    type CoinagePubKey,
    type Invoice,
    type ListenForResult,
    type MerkleRoot,
    type ProductId,
    type PurseId,
    type PurseInfo,
    type Receivable,
    type StandardTransmissionChannel,
    type Timestamp,
    type TransactionHash,
    type TransmissionChannel,
} from "./generated/truapi-coinpayment.js";

import type { CoinPaymentHostApi } from "./generated/truapi-coinpayment.js";

export interface CoinPaymentWindow {
    ua?: {
        ext?: {
            coinpayment?: CoinPaymentHostApi;
        };
    };
}
