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

**`AliasWithProof` needs a runtime that paseo has not deployed yet, and the gap is not in the
encoding.** `People.set_alias_account` requires the proof's context to be one the runtime allows
accounts to be bound in. Individuality `v0.11.2`, which is what paseo-people-next runs today at
`specVersion 1000032`, fixes those contexts as constants that no host-minted context can equal, so
the chain rejects the call however correct the bytes are. Individuality `v0.12.0` derives them with
the same product-scoped construction the host already uses, so
`createRingVRFProof(keyHandle, { productId: "peopl.<network>", suffix: Index(0) }, ...)` produces
exactly the context the call wants. Verified by computing both sides: they are byte-identical.

So this needs no further SDK work and nothing from the host. When paseo upgrades to `1000035`,
regenerate the descriptors and pass that context; the encoding here is already finished and tested
against the deployed metadata.
