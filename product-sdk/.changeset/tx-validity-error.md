---
"@parity/product-sdk-tx": minor
"@parity/product-sdk": minor
---

Stop collapsing pre-inclusion transaction failures to opaque errors.

New `TxValidityError` (extends `TxError`; raw failure payload on `.reason`,
human-readable `.formatted`): `submitAndWatch` now puts it on the `err`
channel for *pre-inclusion* validity/submission failures. Two paths produce
it:

- polkadot-api rejects the subscription with an `InvalidTxError` whose
  `.error` carries the decoded `TransactionValidityError` — e.g.
  `InvalidTransaction::Payment` when the submitter can't pay or isn't
  authorized. The payload is preserved on `.reason` and formatted via the new
  `formatValidityError` helper
  (`{ type: "Invalid", value: { type: "Payment" } }` → `"Invalid.Payment"`).
  Previously this surfaced as a base `TxError` whose message was raw JSON.
- A failure event arrives with **no** `dispatchError` (defensive —
  `dispatchError` only exists for an included-and-failed transaction).
  Previously this became a `TxDispatchError` with the placeholder
  `"unknown error"`.

`formatValidityError(reason)` is exported alongside the other formatters.
`formatDispatchError` now describes the missing-`dispatchError` case
(`"failed before inclusion (validity/submission failure, no dispatch error)"`)
instead of returning `"unknown error"`; its formatting of real dispatch
errors is unchanged.

`withRetry` treats `TxValidityError` as non-retryable, matching how these
failures behaved when they surfaced as `TxDispatchError`.
