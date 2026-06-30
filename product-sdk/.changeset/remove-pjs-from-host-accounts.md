---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

Remove the last PolkadotJS (`polkadot-api/pjs-signer`) dependency from the host account signer factories. `getLegacyAccountSigner` now builds a PAPI `PolkadotSigner` directly over `truApi.signing.createTransactionWithLegacyAccount` / `signRawWithLegacyAccount`, mirroring the product-account `createTransaction` path, so opaque signed extensions (e.g. Paseo Next's `AsPgas`) survive end-to-end for legacy accounts too.

`getProductAccountSigner` drops its `signerType` parameter — the deprecated `"signPayload"` (PJS-bridge) mode is gone; product-account signing always uses the host's `createTransaction` path. The signer's `HostProvider` no longer passes a signer type.
