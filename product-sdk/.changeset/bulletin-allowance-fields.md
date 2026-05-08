---
"@parity/product-sdk-bulletin": patch
"@parity/product-sdk-descriptors": patch
---

**Fix `checkAuthorization` returning incorrect `remainingTransactions` / `remainingBytes` after the upstream `AuthorizationExtent` rename.**

`polkadot-bulletin-chain` PR #448 (`e543696`, 2026-04-30) reshaped the on-chain `AuthorizationExtent` struct: `transactions` and `bytes` are now **consumed counters**, and the granted allowance moved to new fields `transactions_allowance` / `bytes_allowance`. The bulletin SDK was still reading `auth.extent.transactions` and `auth.extent.bytes` directly as the remaining quota — meaning every consumer saw the *consumed* value where it expected *remaining*, so a freshly-authorized account looked like it had `0` left and a fully-consumed one looked unlimited.

### What changed

- `checkAuthorization` now computes `remaining = allowance − consumed` for both transactions and bytes, restoring the public `AuthorizationStatus` contract semantics.
- Bulletin chain metadata regenerated against the new struct so `auth.extent.transactions_allowance` / `bytes_allowance` are typed at compile time. `@parity/product-sdk-descriptors` patch-bumps to ship the regenerated `bulletin.scale` blob and the matching generated TypeScript.

No public API changes — `AuthorizationStatus.remainingTransactions` / `remainingBytes` keep the same names and semantics; the on-chain decode path is the only thing that moved.
