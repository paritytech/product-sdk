---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Add `getCoinPaymentManager()` — the CoinPayment (RFC-0017) merchant flow.**

New `CoinPaymentManager` over `truApi.coinPayment.*`: one-shots
`createPurse` / `queryPurse` / `createReceivable` / `createCheque`, plus
subscription-shaped long-running operations `rebalancePurse` / `deletePurse`
/ `deposit` / `refund` / `listenForPayment` streaming `CoinPaymentStatus`
clearing updates. Distinct from the RFC-0006 user payment surface
(`getPaymentManager`), though both operate on CoinPayment purses. The
CoinPayment wire types (`CoinPaymentPurseId`, `CoinPaymentCheque`,
`CoinPaymentReceivable`, `CoinPaymentStatus`, …) are re-exported from the
host package.
