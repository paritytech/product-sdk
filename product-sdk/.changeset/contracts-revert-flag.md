---
"@parity/product-sdk-contracts": patch
---

Treat the `REVERT` flag on a dispatched-OK `ReviveApi.call` as a revert rather than a successful return.

Adds `ContractRevertedError` (a `ContractError` subclass) and a `ContractRevertInfo` tagged-enum value surfaced on `QueryResult.value` when a contract reverts via the REVERT flag. The discriminant is intentionally distinct from `pallet-revive`'s bare `{ type: "ContractReverted" }` dispatch-error variant, which is the other path that can populate `QueryResult.value` on failure.

Revert payloads are decoded with viem when an ABI is present (standard and ABI-defined errors), surfacing `errorName` and `args` alongside the raw `data` hex.
