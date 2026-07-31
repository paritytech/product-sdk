---
"@parity/product-sdk-terminal": minor
"@parity/product-sdk": minor
---

Allow the `-terminal/host` allocation APIs to target an explicit `productId`.

`requestResourceAllocation` (via `options.productId`), `getCachedAllocation`,
`ensureSlotAccountSigner`, and `createSlotAccountSigner` (via a trailing
optional `productId` parameter) can now override `adapter.appId` for both the
wire `callingProductId` and the slot-cache namespace. Defaults to
`adapter.appId` — no behavior change for existing callers.

Fixes the PGAS mis-mapping footgun where an app whose product id differs from
the terminal's storage `appId` gets its sponsored-gas allowance minted and
auto-mapped on the wrong on-chain account, and brings the allocation side in
line with the signer/read side (`createSessionSignerForAccount`,
`getBulletinSigner`), which already takes an explicit `productId`. Consumers
can delete their `{ ...adapter, appId: productId }` spread workarounds.

> **Warning:** thread the **same** `productId` through **all four** allocation
> APIs — `requestResourceAllocation`, `getCachedAllocation`,
> `ensureSlotAccountSigner`, and `createSlotAccountSigner`. Deleting the
> `{ ...adapter, appId }` spread without passing `productId` everywhere silently
> reintroduces the wrong-account PGAS mint (allowance minted / auto-mapped on
> the account derived from `adapter.appId` instead of your product's account),
> which is exactly the footgun this change closes.
