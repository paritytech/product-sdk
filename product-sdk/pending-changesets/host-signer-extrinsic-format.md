---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
---

**`getProductAccountSigner(account, { extrinsicFormat })` pins the envelope the host builds.**

A product-account signer keeps preferring the signed V4 envelope while the runtime offers it (the SDK still infers no host capability from metadata). A call that must go out as a V5 general transaction — one carrying an origin extension such as `withScoreParticipant` or `withLiteAlias`, whose authorization lives in the runtime's transaction-extension pipeline — can now say so:

```ts
const signer = accounts.getProductAccountSigner(account, { extrinsicFormat: "v5" });
```

`extrinsicFormat` is `"v4" | "v5"`; a pinned format the runtime does not offer throws at `signTx`, naming the formats it does. `HostProvider.getProductAccountSigner` in `@parity/product-sdk-signer` takes the same option. Without it, products that need the general transaction on the Rust host (which builds V4 for `txExtVersion: 0`, while the iOS and Android hosts build V5 general there) had to re-implement the whole `createTransaction` call around the SDK signer to send `txExtVersion: 5` themselves.
