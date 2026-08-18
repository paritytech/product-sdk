---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Update TrUAPI to 0.9 and require registered ring-VRF key handles.**

`AccountsProvider`, `HostProvider`, and `SignerManager` now expose
`registerRingVrfKey(index, ring)` and `listRingVrfKeys(owner, disclosure?)`. Registration returns
the decoded ring-VRF public key; listing returns `RegisteredRingVrfKey` entries with opaque
`RingVrfKeyHandle` values. `findRingVrfKeyHandle(keys, ring)` selects a handle by declared
`RingLocation`, so products do not hard-code another product's derivation index.

`getProductAccountAlias` and `createRingVRFProof` now require that handle as their first argument.
This is a compile-time breaking change. It matches TrUAPI 0.9, where the host no longer chooses a
ring member key implicitly and rejects malformed legacy requests before application dispatch.

The dependency update also adopts TrUAPI's renamed derivation-index variants: `Index` replaces
`Left` and `Raw` replaces `Right`. The SDK's ergonomic numeric product-account APIs are unchanged;
the host adapter performs the `Index` conversion at the wire boundary.

The signer package's re-exported `RingLocation` now uses TrUAPI's `` chainId: `0x${string}` ``
instead of a plain `string`; callers loading chain IDs from configuration must narrow or validate
them before assignment. Custom `HostProviderOptions.loadAccountsProvider` implementations must
also provide the newly required `registerRingVrfKey` and `listRingVrfKeys` methods.
