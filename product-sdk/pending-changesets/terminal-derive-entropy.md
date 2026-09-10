---
"@parity/product-sdk-terminal": minor
---

Add `deriveEntropy(session, productId, key)` — client-side RFC-0007 product-entropy derivation for terminal (QR/SSO) sessions, byte-for-byte identical to the host's `host_derive_entropy` (i.e. `@novasamatech/host-container`'s `deriveProductEntropyFromSource`).

The paired `UserSession` carries `rootEntropySource` (RFC-0007 layer 1), so layers 2 and 3 are computed locally with no host round-trip:

```
perProduct = blake2b256(rootEntropySource, key = blake2b256(utf8(productId)))
entropy    = blake2b256(perProduct,        key = key)
```

Entropy derived here matches what an in-container app gets from `@parity/product-sdk-host`'s `deriveEntropy` for the same wallet + product + key, so entropy-derived keys interoperate across web and terminal clients. A golden-vector test pins the construction against `host-container`. (issue #254)
