---
"@parity/product-sdk-host": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk-statement-store": patch
---

Bump `@novasamatech/host-api` and `@novasamatech/host-api-wrapper` to `^0.8.4`.

0.8.4 ships the `getLegacyAccountSigner` SS58 fix: the wrapper now sends an
SS58 address as the wire `signer` instead of a raw hex public key, so
legacy-account `signRaw`/`signPayload` are accepted by the wallet instead of
rejected. Fixes the root cause behind
[paritytech/product-sdk#156](https://github.com/paritytech/product-sdk/issues/156).
