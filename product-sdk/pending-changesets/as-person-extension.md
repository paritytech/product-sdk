---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Add `withAsPerson`, so a product can send a call that dispatches under a person origin.**

`withAsPerson(signer, info)` wraps a `PolkadotSigner` and builds the People chain's `AsPerson`
transaction extension around it. It returns a `PolkadotSigner`, so submission stays with
`@parity/product-sdk-tx` and nothing there changes: pass the wrapped signer to `submitAndWatch`,
`batchSubmitAndWatch` or `signSubmitAndWatch` as usual.

Three variants are typed. `AliasWithAccount` needs no proof and is the everyday case, for an account
already bound to an alias by `People.set_alias_account`: it reads the nonce from the slot PAPI
already filled, so the extension's copy and the body's copy cannot disagree. `AliasWithProof` and
`AliasWithAccountRevised` take a `createProof(message)` callback, which is handed the call
implication hash. The message is computed here, never chosen by the caller, because it covers the
nonce, the era, the tip and every other extension after `AsPerson`.

Two things this handles that a hand-rolled extension does not. It sets `RestrictOrigins` to `true`,
which PAPI defaults to `false` and which the origin-restriction pallet rejects outright for a person
origin, before dispatch and with no dispatch error to read. And for `AliasWithProof` it supplies
`VerifyMultiSignature` as `Disabled`, which is what makes the host assemble an unsigned general
transaction so the origin is `None`, the only origin that variant accepts.

Everything is encoded from the runtime metadata the transaction is being signed against, never from
a hand-written type. The deployed `AsPersonInfo` and the upstream `polkadot-sdk` one both declare a
variant named `AsPersonalAliasWithProof` with different field lists, so an upstream-derived encoder
would emit plausible bytes with a field missing. The metadata-driven pieces are exported for the same
reason — `readExtensionPipeline`, `buildImplication`, `implicationMessage`, `encodeChecked` — since
every origin-modifying extension on this chain is bound the same way.

Errors arrive as a thrown `AsPersonError`, not on a `Result` channel, because they happen inside
`PolkadotSigner.signTx`.

**`AliasWithProof` is not yet reachable from product code, and the gap is not in the encoding.**
`People.set_alias_account` requires the proof's context to be one the runtime allows accounts to be
bound in, and the host only mints product-scoped contexts. The encoding is finished and tested
against the deployed metadata; when a call minting a runtime-fixed context exists, it wires in
through the existing callback with no change here.
