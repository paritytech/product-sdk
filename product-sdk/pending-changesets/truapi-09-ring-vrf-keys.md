---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Update TrUAPI to 0.9 and require registered ring-VRF key handles.**

`AccountsProvider`, `HostProvider`, and `SignerManager` now expose
`listRingVrfKeys(owner, disclosure?)`. The returned `RegisteredRingVrfKey` entries carry opaque
`RingVrfKeyHandle` values. `findRingVrfKeyHandle(keys, ring)` selects a handle by declared
`RingLocation`, so products do not hard-code another product's derivation index.

`getProductAccountAlias` and `createRingVRFProof` now require that handle as their first argument.
This is a compile-time breaking change. It matches TrUAPI 0.9, where the host no longer chooses a
ring member key implicitly and rejects malformed legacy requests before application dispatch.

The dependency update also adopts TrUAPI's renamed derivation-index variants: `Index` replaces
`Left` and `Raw` replaces `Right`. The SDK's ergonomic numeric product-account APIs are unchanged;
the host adapter performs the `Index` conversion at the wire boundary.
