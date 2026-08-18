---
"@parity/product-sdk": minor
"@parity/product-sdk-signer": patch
---

**Deprecate the context-alias helpers, delete the unimplemented ring-alias stubs (#287).**

`deriveContextAlias` returns addresses that can receive value and can never spend it: the alias
public key is `blake2b256(parentPublicKey || context)`, a hash rather than a derived key, so no
secret corresponds to the SS58 address or the H160. The address encodes and validates fine, so
nothing surfaces until value arrives at it.

**Deleted:** `deriveAnonymousAlias`, `createRingProof`, `verifyRingProof`, `AnonymousAliasInfo`,
and identity's `RingLocation`. Each function was a debug log followed by an unconditional
`throw`, with no branch or early return, so no working consumer could exist and this break is
compile-time only. The real ring VRF operations already live on `SignerManager` in
`@parity/product-sdk-signer` as `getProductAccountAlias` and `createRingVRFProof`, host-backed
against a ring-VRF key the product registers up front and then names per call. Identity's `RingLocation` was also the wrong
shape, `{ringIndex, memberIndex}` against the protocol type `{chainId, junctions}`.

**Deprecated, removal in `@parity/product-sdk` 0.23.0:** `deriveContextAlias`,
`verifyContextAlias`, `ContextAliasInfo`. Their output is unchanged, so a caller using an alias as
a plain identifier has a release to migrate. `verifyContextAlias` compares two public values with
no secret involved anywhere, so it confirms a derivation relationship and authenticates nothing.

The derivation output is deliberately unchanged: the same name and signature returning different
bytes would break identifier consumers silently, with no compile error.

### Migration

| If you used it for | Use instead |
|---|---|
| An account that holds or spends value | `SignerManager.getProductAccount(dotNsIdentifier, index)` from `@parity/product-sdk-signer` |
| The address offline, with no host | `deriveProductAccountPublicKey` from `@parity/product-sdk-keys`, the canonical sr25519 soft derivation |
| An unlinkable per-context alias | `SignerManager.getProductAccountAlias(keyHandle, context, location)`, plus `createRingVRFProof` for proofs |
| A context-scoped identifier, never used as an account | `blake2b256` from `@parity/product-sdk/crypto`: the same bytes, without address packaging |

The DotNS half of `./identity` is unaffected (`resolveDotNs`, `reverseDotNs`, `isDotNsAvailable`,
`resolvePeopleUsernameOwner` and the name helpers), and the subpath itself is not deprecated.

`@parity/product-sdk-signer` takes a patch for one doc comment: its local `RingLocation` claimed
to match the product-sdk shape, which was the opposite shape and is now deleted. No type or
behaviour change.
