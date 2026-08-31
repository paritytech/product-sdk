---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**`withLiteAlias` runs a call under a lite-person origin, the way `withAsPerson` runs one under a person origin.**

Wrap a signer and the `PeopleLiteAuth` transaction extension is filled inside `signTx`, where the nonce and the extension pipeline exist and are still patchable. Three variants: `AliasWithAccount` for calls signed by an account already bound to the lite alias (the free game sign-up leg, `Game.sign_up_with_account_lite_invite`), `AliasWithProof` for the unsigned, ring-VRF-authorized `PeopleLite.set_alias_account` bind leg, and `AliasWithAccountRevised` to refresh a stale binding. Proof messages are computed from the chain's own metadata — blake2-256 of the implication after `PeopleLiteAuth`, or the pallet's `(implication, "revise", account, nonce)` tuple — and never chosen by the caller.

```ts
const signer = withLiteAlias(accounts.getProductAccountSigner(account), {
    tag: "AliasWithAccount",
});
await submitAndWatch(
    api.tx.Game.sign_up_with_account_lite_invite({ account, identifier_key, airdrops }),
    signer,
);
```

The machinery under `withAsPerson` was already generic over the extension identifier; the slot patching, nonce read-back, proof-request guards and pipeline cache it kept file-private now live in an internal shared module both signers use. Encoding is still round-tripped through the metadata of the blob being signed against, which is load-bearing here too: the devnet runtime declares the proof variants without the `RevisionIndex` field the deployed runtimes carry, and that mismatch is a thrown `AsPersonError` rather than a structurally plausible wrong encoding. No behaviour change for `withAsPerson`.
