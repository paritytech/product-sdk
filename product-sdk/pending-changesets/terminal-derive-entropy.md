---
"@parity/product-sdk-terminal": minor
---

Add `deriveEntropy(session, productId, key)` — client-side RFC-0007 product-entropy derivation for terminal (QR/SSO) sessions, conforming to host-spec §C.8.

The paired `UserSession` carries `rootEntropySource` (RFC-0007 layer 1), so layers 2 and 3 are computed locally with no host round-trip:

```
layer2 = blake2b256_keyed(key = blake2b256(utf8(productId)), msg = rootEntropySource)
result = blake2b256_keyed(key = callerKey,                   msg = layer2)
```

Entropy derived here matches what an in-container app gets from `@parity/product-sdk-host`'s `deriveEntropy` for the same wallet + product + key, so entropy-derived keys interoperate across web and terminal clients. The implementation is pinned against the canonical cross-language conformance vectors shared with the Rust, Kotlin and Swift hosts.

`productId` is case-sensitive and used verbatim, and the host scopes it per deployment — production, PR previews and local dev derive different entropy. Pass the same identifier you pass to `requestResourceAllocation`. (refs #254)
