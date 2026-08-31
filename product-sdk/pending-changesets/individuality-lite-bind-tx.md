---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**`buildLiteAliasBindTx` encodes the lite sign-up's bind leg entirely client-side.**

`PeopleLite.set_alias_account(account, valid_at_block)` under
`PeopleLiteAuth::AsLiteAliasWithProof` is an unsigned V5 *general* extrinsic —
origin `None`, no signature — so it cannot ride a `PolkadotSigner`, and until
now the only way to assemble it was the host's `createTransaction`. With the
extension pipeline read from the chain's own metadata the SDK now builds the
whole extrinsic itself: every extra takes the value a general transaction needs
(`RestrictOrigins` enabled, `VerifyMultiSignature` disabled, immortal era,
zero nonce and tip, every origin `Option` slot `None`), the ring-VRF proof is
requested over the implication after `PeopleLiteAuth` — never chosen by the
caller — and the result is finished bytes for any raw submit, plus the proof's
ring coordinates for logging. `valid_at_block` is the chain's best block at
build time; `account` is a plain call parameter, which is what lets the
personhood product vouch for another product's account.

```ts
const { transaction } = await buildLiteAliasBindTx(chain, {
    account,
    createProof: (message) =>
        accounts.createRingVRFProof(liteKeyHandle, scoreContext, litePeopleRing(genesis), message),
});
await client.submit(`0x${bytesToHex(transaction)}`);
```

The byte layout (`compact(len) ++ 0x45 ++ extensionVersion ++ extras ++ call`)
reproduces the encoding verified live on previewnet (spec 1000036) as the first
of the two lite sign-up transactions, and the tests pin it byte for byte
against the previewnet and paseo metadata. Chains whose `PeopleLiteAuth`
predates the deployed field list (devnet) are a loud error, not a plausible
wrong encoding. Nothing here chooses a chain, a product id or a context: run
`readScoreContext` first and stop on `NotProductDerived`, and skip the leg when
`PeopleLite.AccountToAlias` already holds the binding.
