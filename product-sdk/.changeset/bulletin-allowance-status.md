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
`remainingBlocks` (`max(0, expiration - currentBlock)`) and `usable`
(`authorized && currentBlock < expiration` — the chain's only hard gate).
Errors from either on-chain read propagate on the `err` channel.
