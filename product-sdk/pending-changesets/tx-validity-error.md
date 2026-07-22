---
"@parity/product-sdk-tx": minor
"@parity/product-sdk": minor
---

Stop collapsing pre-inclusion transaction failures to opaque errors.

New `TxValidityError` (extends `TxError`; raw failure payload on `.reason`,
human-readable `.formatted`): `submitAndWatch` now puts it on the `err`
channel for *pre-inclusion* validity/submission failures: polkadot-api
rejects the subscription with an `InvalidTxError` whose `.error` carries the
decoded `TransactionValidityError` — e.g. `InvalidTransaction::Payment` when
the submitter can't pay or isn't authorized. The payload is preserved on
`.reason` and formatted via the new `formatValidityError` helper
(`{ type: "Invalid", value: { type: "Payment" } }` → `"Invalid.Payment"`).
Previously this surfaced as a base `TxError` whose message was raw JSON.

An *included* failure event that carries no `dispatchError` — an anomaly,
since `dispatchError` normally exists once a tx is included — is classified
as a `TxDispatchError` with a neutral message, no longer the placeholder
`"unknown error"`. It is deliberately **not** a `TxValidityError`: that type
is reserved for genuine pre-inclusion failures, and this case is
post-inclusion.

`formatValidityError(reason)` is exported alongside the other formatters.

`withRetry` treats `TxValidityError` as non-retryable, matching how these
failures behaved when they surfaced as `TxDispatchError`.
