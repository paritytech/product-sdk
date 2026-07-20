---
"@parity/product-sdk-contracts": minor
"@parity/product-sdk": minor
---

Validate the dry-run/tx origin before it reaches PAPI's `AccountId` codec.

A non-SS58 origin — most commonly the account's H160 (`0x…`), since
pallet-revive derives the H160 `msg.sender` *from* the SS58 origin — used to
fail deep inside the encode stack as a bare `Invalid checksum` with no hint
about the cause. All three call paths now validate the resolved origin with
`isValidSs58` and produce a new `ContractInvalidOriginError extends
ContractError` (message includes the rejected value, plus a "looks like an
H160 — convert it with `h160ToSs58`" hint when applicable):

- `.tx()` and `.prepare()` return it as `err(ContractInvalidOriginError)`;
- `.query()` **throws** it (`QueryResult` has no error channel — the one
  deliberate asymmetry).

Validation only — no auto-conversion, so the SDK never silently changes which
account the caller believes is calling.
