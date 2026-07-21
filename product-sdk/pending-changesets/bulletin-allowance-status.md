---
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk": minor
---

Bulletin allowance status read-back: `getBulletinAllowanceStatus`.

New `getBulletinAllowanceStatus(api, slotAddress)` returns
`Result<BulletinAllowanceStatus, CloudStorageAuthorizationError>`, composing
the existing `checkAuthorization` quota read with a `System.Number`
current-block read. `BulletinAllowanceStatus extends AuthorizationStatus` with
the two derived fields every consumer re-computes by hand:
`remainingBlocks` (`max(0, expiration - currentBlock)`) and `usable`.

`usable` folds in every hard gate the chain enforces: the authorization must
exist, be unexpired (`currentBlock < expiration`), **and** have quota left
(`remainingTransactions > 0` and `remainingBytes > 0`). Expiry is not the only
gate — the chain also rejects a store once the transaction or byte quota is
exhausted. `usable === true` still does not guarantee a given store will fit:
callers must size-check `remainingBytes` against their actual payload.

Errors from either on-chain read propagate on the `err` channel.
