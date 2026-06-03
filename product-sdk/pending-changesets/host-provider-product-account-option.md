---
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Add `HostProviderOptions.productAccount` for product-account-only apps.**

Apps that sign exclusively with a per-dapp derived product account (no
wallet picker — typical for the modern PoP-mediated flow) can now pass
`productAccount: { dotNsIdentifier, derivationIndex? }` when constructing
`HostProvider`. When set, `connect()`:

- Skips `getLegacyAccounts()` entirely.
- Fetches the product account via `getProductAccount(dotNsIdentifier, derivationIndex)`.
- Best-effort fetches the user's primary username via `getUserId()`
  and uses it as `SignerAccount.name` so apps can render
  `Hello, {name}` instead of a truncated address. Failures
  (`NotConnected`, `PermissionDenied`, codec drift) leave `name` null —
  connect still succeeds, callers fall back to whatever display rule
  they already use.
- Returns it as a single-element `SignerAccount[]` so it flows into
  `SignerState.accounts` and becomes `selectedAccount` like any other
  account.
- Wires `getSigner` through `getProductAccountSigner` (pinned to
  `createTransaction`).

This obsoletes the ~25-line `class extends HostProvider` workaround every
product app was carrying. Critically, it also fixes a v0.5.0 regression:
when the host returns no legacy accounts, `super.connect()` rejects with
`NoAccountsError` *before* any product-account fetch can happen — leaving
product-only apps stuck in `status: "disconnected"`. The new option
bypasses that branch entirely.

Existing consumers (apps that don't set `productAccount`) see no
behavior change.

Example:

```ts
new HostProvider({
  productAccount: { dotNsIdentifier: "myapp.dot" },
});
```
