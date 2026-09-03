---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Full-personhood registration: `Score.register` builders, the readiness read, and `withScoreParticipant`.**

The step after the score is in. `registerMessage(account)` pins the byte-exact proof-of-ownership contract — `"pop register using" ++ account`, a raw 50-byte concatenation, never SCALE — and `registerPersonhoodTx(chain, { memberKey, proofOfOwnership })` builds `Score.register(Some((member_key, sig)))` from it, width-checked (32-byte Bandersnatch member key, 64-byte plain signature). The pair is caller-supplied and opaque: only the personhood product's own host session can mint it (`registerRingVrfKey(Index(0), peopleRing)` + `ringVrfSign`), so the builder never tries, which lets the same code serve a cross-product handoff and a future single-product path unchanged. `readRegistrationEligibility` folds `Score.Participants` and `Score.PersonhoodThreshold` — a storage item on a session schedule, not a constant — at one pinned block into `readyToRegister`, also exported as the pure predicate.

`withScoreParticipant(signer)` is the third signer on the origin-extension machinery `withAsPerson` and `withLiteAlias` share: it sets `RestrictOrigins`, reads the nonce back out of the `CheckNonce` slot PAPI filled, and writes `ScoreAsParticipant(Some(nonce))` — fee-free dispatch from a 0-balance participant account. No caller-supplied nonce, same as the siblings: the chain checks the extension's nonce against `CheckNonce`, and reading it back is what makes disagreement impossible. Encoding round-trips through the chain's own metadata, which is load-bearing here too: the extension is a newtype over `Option` of a newtype, and the plausible `{ nonce }` shape silently encodes `Some(0)` — measured, and rejected as a thrown `AsPersonError`.

```ts
const eligibility = await readRegistrationEligibility(chain, { registrant });
if (eligibility.ok && eligibility.value.readyToRegister) {
    const tx = registerPersonhoodTx(chain, { memberKey, proofOfOwnership });
    await submitAndWatch(tx, withScoreParticipant(accounts.getProductAccountSigner(account)));
}
```

Verified against the flow that ran live on previewnet (spec 1000036, individuality v0.12.1) on 2026-08-28.
