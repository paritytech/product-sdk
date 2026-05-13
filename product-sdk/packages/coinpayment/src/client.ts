import { CoinPaymentException, type CoinPaymentHostApi, type CoinPaymentWindow } from "./types.js";

export interface CreateCoinPaymentClientOptions {
    host?: CoinPaymentHostApi;
    windowLike?: CoinPaymentWindow;
}

export function createCoinPaymentClient(
    options: CreateCoinPaymentClientOptions = {},
): CoinPaymentHostApi {
    const host = options.host ?? resolveHost(options.windowLike);
    if (!host)
        throw new CoinPaymentException(
            "userAgentCapabilityUnavailable",
            "CoinPayment user-agent API is unavailable",
        );
    return host;
}

function resolveHost(
    windowLike = globalThis.window as CoinPaymentWindow | undefined,
): CoinPaymentHostApi | undefined {
    return windowLike?.ua?.ext?.coinpayment;
}
