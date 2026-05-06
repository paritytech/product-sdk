import {
    MerchantPaymentException,
    type CreateClaimSessionRequest,
    type CreateClaimSessionResponse,
    type CreateIntentRequest,
    type CreateIntentResponse,
    type CreateRefundIntentRequest,
    type CreateRefundIntentResponse,
    type GetIntentRequest,
    type IntentStatusItem,
    type MerchantPaymentSubscriptionErrorHandler,
    type MerchantPaymentsHostApi,
    type MerchantPurseStatus,
    type PaymentIntent,
    type PurseStatusScope,
    type RefundStatusItem,
    type SubscribeIntentStatusRequest,
    type SubscribeRefundStatusRequest,
} from "./types.js";

interface MerchantPaymentsWindow {
    ua?: {
        ext?: {
            merchantPayments?: MerchantPaymentsHostApi;
        };
    };
}

function getHostApi(): MerchantPaymentsHostApi {
    const api = (globalThis.window as (Window & MerchantPaymentsWindow) | undefined)?.ua?.ext
        ?.merchantPayments;
    if (!api) {
        throw new MerchantPaymentException(
            "hostCapabilityUnavailable",
            "window.ua.ext.merchantPayments is not available",
        );
    }
    return api;
}

export class MerchantPaymentsClient {
    createIntent(request: CreateIntentRequest): Promise<CreateIntentResponse> {
        return getHostApi().createIntent(request);
    }

    createClaimSession(request: CreateClaimSessionRequest): Promise<CreateClaimSessionResponse> {
        return getHostApi().createClaimSession(request);
    }

    getIntent(request: GetIntentRequest): Promise<PaymentIntent> {
        return getHostApi().getIntent(request);
    }

    createRefundIntent(request: CreateRefundIntentRequest): Promise<CreateRefundIntentResponse> {
        return getHostApi().createRefundIntent(request);
    }

    getPurseStatus(scope: PurseStatusScope): Promise<MerchantPurseStatus> {
        return getHostApi().getPurseStatus({ scope });
    }

    subscribeIntentStatus(
        request: SubscribeIntentStatusRequest,
        callback: (item: IntentStatusItem) => void,
        onError?: MerchantPaymentSubscriptionErrorHandler,
    ): () => void {
        return getHostApi().subscribeIntentStatus(request, callback, onError);
    }

    subscribeRefundStatus(
        request: SubscribeRefundStatusRequest,
        callback: (item: RefundStatusItem) => void,
        onError?: MerchantPaymentSubscriptionErrorHandler,
    ): () => void {
        return getHostApi().subscribeRefundStatus(request, callback, onError);
    }
}

export function createMerchantPaymentsClient(): MerchantPaymentsClient {
    return new MerchantPaymentsClient();
}
