---
"@parity/product-sdk-bulletin": minor
---

**Bulletin: add `authorizeAccount` helper.**

Adds a top-level `authorizeAccount` function and a matching `BulletinClient.authorizeAccount` class method for granting bulletin-storage authorizations to an account on chain. Pairs with the existing `checkAuthorization` pre-flight helper so consumers can both inspect and grant authorization without dropping to the upstream builder.

### New surface — `@parity/product-sdk-bulletin`

- `authorizeAccount(api, options)` — top-level helper.
- `BulletinClient.authorizeAccount(options)` — class-method form using the client's bound api.
- `AuthorizeAccountOptions` — options type re-exported from `@parity/product-sdk-bulletin`.

Pure addition; no breaking changes.
