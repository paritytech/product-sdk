---
"@parity/product-sdk-bulletin": patch
"@parity/product-sdk-descriptors": patch
---

**Bulletin: read allowance fields from `AuthorizationExtent`.**

`checkAuthorization` was reading `auth.extent.transactions` / `auth.extent.bytes` and exposing them as `remainingTransactions` / `remainingBytes`. After [`paritytech/polkadot-bulletin-chain#448`](https://github.com/paritytech/polkadot-bulletin-chain/pull/448) ("Adds `AllowanceBasedPriority` extension", commit `e543696`, 2026-04-30, picks fields from #469), those source fields are **consumed counters**; the granted total moved to new `transactions_allowance` / `bytes_allowance` fields.

On a post-#448 chain (every live Bulletin chain today), a fresh `authorize_account(100, 1MB)` left `auth.extent.transactions = 0` (the consumed counter) — `checkAuthorization` then returned `remainingTransactions: 0`. Consumers using "if remaining < required, re-authorize" loops would re-authorize on every upload. Not a hard failure (the `authorize_account` extrinsic is additive), but produces unbounded quota growth and an extra extrinsic per upload.

**Fix:** compute `remaining = allowance − consumed` from the new fields. Public `AuthorizationStatus` type unchanged; consumer code keeps working.

Includes a `papi update bulletin` to refresh the bundled metadata snapshot to the post-#448 5-field struct (`transactions`, `transactions_allowance`, `bytes`, `bytes_permanent`, `bytes_allowance`).

Mirrors the equivalent fix in [`@parity/dotns-cli@0.6.1`](https://github.com/paritytech/dotns-sdk/pull/125) (commit `d95e7d0`).
