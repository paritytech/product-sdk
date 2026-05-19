---
"@parity/product-sdk": minor
---

**Rename `@parity/product-sdk/identity`'s `deriveProductAccount` to `deriveContextAlias` (and `verifyProductAccount` to `verifyContextAlias`, `ProductAccountInfo` to `ContextAliasInfo`, field `productName` to `context`).**

The identity-subpath helper is a blake2b256-based deterministic alias
derivation: `aliasPublicKey = blake2b256(parentPublicKey || context)`.
Used for scoping a parent account to a context label (an app id, a
voting round, a channel name, etc.). The old `deriveProductAccount`
naming collided with the *canonical* sr25519 product-account derivation
shared with polkadot-desktop and polkadot-app-android-v2: two distinct
algorithms that produce different outputs from the same inputs. The
rename makes the algorithmic difference legible at the call site.

For the canonical sr25519 product-account derivation, see the new
`deriveProductAccountPublicKey` in `@parity/product-sdk-keys` (this
release wave).

### Breaking changes

- `deriveProductAccount(parentAddress, productName, ss58Prefix?)` is
  now `deriveContextAlias(parentAddress, context, ss58Prefix?)`. Same
  algorithm, same output bytes, only the names changed.
- `verifyProductAccount(productAddress, parentAddress, productName)`
  is now `verifyContextAlias(aliasAddress, parentAddress, context)`.
- Type `ProductAccountInfo` is now `ContextAliasInfo`. Field
  `productName: string` is now `context: string`. Other fields
  (`address`, `h160Address`, `parentAddress`) unchanged.

Runtime behavior is unchanged on the success path: addresses derived
under the old API are bit-identical to those derived under the new API
for the same `(parentAddress, oldProductName === newContext)` pair.

### Migration

Mechanical find/replace across consumer code:

```ts
// Before:
import {
    deriveProductAccount,
    verifyProductAccount,
    type ProductAccountInfo,
} from "@parity/product-sdk/identity";

const acct: ProductAccountInfo = deriveProductAccount(parentAddress, "my-app");
const ok = verifyProductAccount(acct.address, parentAddress, "my-app");
console.log(acct.productName);

// After:
import {
    deriveContextAlias,
    verifyContextAlias,
    type ContextAliasInfo,
} from "@parity/product-sdk/identity";

const alias: ContextAliasInfo = deriveContextAlias(parentAddress, "my-app");
const ok = verifyContextAlias(alias.address, parentAddress, "my-app");
console.log(alias.context);
```

### Why minor, not major

Per `RELEASES.md`, pre-1.0 breaking changes go out as `minor` in this
repo. `@parity/product-sdk` is on `0.5.0`; this rename ships at `0.6.0`.
