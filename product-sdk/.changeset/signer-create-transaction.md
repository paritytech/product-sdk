---
"@parity/product-sdk-signer": patch
---

Pin product-account signing to `host_create_transaction` explicitly.

Both product-account signer entry points — the `getSigner()` returned from `HostProvider.getProductAccount(...)` and the standalone `HostProvider.getProductAccountSigner(...)` method — now pass `signerType: "createTransaction"` to `@novasamatech/host-api-wrapper`'s `accountsProvider.getProductAccountSigner(...)`. The alternate `"signPayload"` path routes via PJS and throws `"PJS does not support this signed-extension: AsPgas"` on chains that ship unknown signed extensions (e.g. Paseo Next's `AsPgas`).

The `host-api-wrapper@0.7.9` bump that already landed flipped the upstream default to `"createTransaction"`, so AsPgas signing is already unblocked at runtime. This change is **defensive**: it pins our routing explicitly so a future upstream default flip can't silently regress us back through the PJS bridge. Same end-state, plus call-site legibility.

Legacy-account signing is unchanged — `getLegacyAccountSigner` doesn't expose a `signerType` switch.

No consumer-facing API change. Hosts must implement `host_create_transaction` (Polkadot Desktop and Mobile do).
