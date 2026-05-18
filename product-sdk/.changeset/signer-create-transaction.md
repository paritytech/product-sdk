---
"@parity/product-sdk-signer": patch
---

fix(signer): route product-account signing through `host_create_transaction`

Both product-account signer entry points — the `getSigner()` returned
from `HostProvider.getProductAccount(...)` and the standalone
`HostProvider.getProductAccountSigner(...)` method — now pass
`signerType: "createTransaction"` to Nova's
`accountsProvider.getProductAccountSigner(...)`, which was previously
called with no second argument and defaulted to the deprecated
`"signPayload"` PJS-style path. The PJS path strips unknown signed
extensions and throws
`"PJS does not support this signed-extension: AsPgas"` on chains that
ship the `AsPgas` extension (Paseo Next).

Legacy-account signing is unchanged — Nova's `getLegacyAccountSigner`
doesn't expose a `signerType` switch.

The new path requires `@novasamatech/product-sdk` 0.7.9 or later and a
host build (Polkadot Desktop, Polkadot Mobile) that implements
`host_create_transaction`. Older Nova versions ignore the extra argument
at runtime, so the change is backward-compatible at the call-site level —
but apps that hit older hosts will need to upgrade those hosts before
signing works again.