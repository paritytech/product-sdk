---
"@parity/product-sdk": minor
"@parity/product-sdk-signer": patch
---

**Removed: `deriveContextAlias`, `verifyContextAlias`, `ContextAliasInfo`.**

Deprecated in `0.22.0`, which named `0.23.0` as the removal version. This is that release.

`deriveContextAlias` returned addresses no key can spend: the alias public key was
`blake2b256(parentPublicKey || context)`, a hash rather than a derived key, so no secret
corresponded to the SS58 address or to the H160. Both could receive value and neither could ever
send it. `verifyContextAlias` compared two public values, so a `true` result showed a derivation
relationship and never that anyone controlled either account.

Replace by intent:

- An account that holds or spends value: `SignerManager.getProductAccount(dotNsIdentifier, index)`
  from `@parity/product-sdk-signer`. Host backed and actually signable.
- The address offline, with no host: `deriveProductAccountPublicKey` from
  `@parity/product-sdk-keys`, the canonical sr25519 soft derivation.
- An unlinkable per-context alias: select a registered ring VRF key, then
  `SignerManager.getProductAccountAlias(keyHandle, context, location)` or
  `createRingVRFProof(keyHandle, context, location, message)`.
- A context-scoped identifier that was never an account: `blake2b256` from
  `@parity/product-sdk/crypto`. Same bytes, without the address packaging that invited the mistake.

If you used an alias purely as an opaque identifier, the `blake2b256` route gives byte-identical
output, so stored values stay valid.
