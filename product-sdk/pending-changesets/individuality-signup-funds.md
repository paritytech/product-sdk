---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Read what a game sign-up costs: `readSignUpFunds`.**

`readSignUpFunds(chain, { account, tx })` returns the parts of the cost at one pinned finalized block: `deposit` from `Game.PlayDepositAmount`, the free balance from `System.Account`, and `estimatedFee` for the sign-up transaction passed as `tx`, or `null` without one. It also returns the token `decimals` and `symbol` the chain spec publishes, `null` where it publishes none. How much headroom to demand on top is product policy, so no total is given.

The deposit applies to a new or archived player only, and the fee is refunded on success but needed up front. Neither applies under `withScoreParticipant`.

The estimate passes `VerifyMultiSignature` as `Disabled`. Estimating a sign-up on the individuality chains with plain `getEstimatedFees` fails with `Missing VerifyMultiSignature signed extension`, because the host fills that extension when it signs.
