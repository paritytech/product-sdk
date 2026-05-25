---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
---

**Add `getPaymentManager` for RFC-0006 host payments.**

`@parity/product-sdk-host` now exports `getPaymentManager()` plus the `PaymentManager`, `PaymentBalance`, `PaymentStatus`, and `TopUpSource` types. The wrapper returns the shared `paymentManager` singleton from `@novasamatech/host-api-wrapper`, matching the singleton pattern already used by `getPreimageManager`, `getHostLocalStorage`, and `getAccountsProvider`.

Closes the last `@novasamatech/host-api-wrapper` direct-import in the host-playground migration: callers can swap `createPaymentManager()` for `await getPaymentManager()`.

Distinct from the CoinPayment / merchant-payments surface (RFC-0017). This is the user-initiated balance / top-up / payment-request flow.
