---
"@parity/product-sdk-contracts": minor
"@parity/product-sdk": minor
---

Export the pallet-revive account-mapping read probe.

New `isContractAccountMapped(runtime, address)` returns
`Result<boolean, ContractError>` — the read-only half of
`ensureContractAccountMapped`, extracted from its inline checker. It derives
the H160 via `ss58ToH160` and reads `Revive.OriginalAccount`; no signer, no
transaction, no wallet prompt, so it's safe for "is this account ready to make
contract calls?" checks. `ensureContractAccountMapped` now reuses it
internally (a failed probe still surfaces as `TxAccountMappingError`, with the
`ContractError` attached on the cause chain).
