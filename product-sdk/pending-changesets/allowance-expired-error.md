---
"@parity/product-sdk-signer": minor
"@parity/product-sdk-terminal": minor
"@parity/product-sdk": minor
---

Typed `AllowanceExpiredError` for signs that fail on a lapsed allowance.

New `AllowanceExpiredError` in `@parity/product-sdk-signer` (extends
`SignerError`, so it carries the shared `SdkError` marker; `.resource` names
the lapsed allowance, `.cause` holds the underlying failure). The terminal
session signers (`signTx` via `session.createTransaction`, `signBytes` via
`session.signRaw`) now reject with it when the failure is the statement-store
`NoAllowanceError` (matched directly or anywhere on the `cause` chain) instead
of a generic `Error` — so consumers can `catch (e) { if (e instanceof
AllowanceExpiredError) … }` and prompt a re-pair, rather than string-matching
console output.

Deliberately **thrown**, not returned as a `Result` `err`: it surfaces at
PAPI's `PolkadotSigner.signTx`/`signBytes` boundary, whose contract is a
rejecting Promise — an intentional exception to the SDK-wide Result
convention. Re-exported from `@parity/product-sdk-terminal` (which gains a
`@parity/product-sdk-signer` workspace dependency).

Note: the root-cause fix for the 240 s hang before this error is even
reachable lives upstream in `@novasamatech/host-papp`
(`awaitReplyOrAckFailure` drops rejected ACKs) and is tracked separately.
