---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Build the game report and offboard calls: `reportTx` and `offboardTx`.**

`reportTx(chain, { fullReport })` builds `Game.report` from `"Person" | "NotPerson"` votes, one list per round in group order with the reporter left out. `offboardTx(chain)` builds `Game.offboard`. Both return the unsigned PAPI transaction, like `claimPrizeTx`, so submission stays with `@parity/product-sdk-tx`.

Sign both with `withScoreParticipant(signer)`, which dispatches them fee-free from an account with no balance. The `signUpWithAccountTx` docs now say the same origin serves a returning player signing up again.

Offboarding a `Recognized` player suspends their personhood permanently, which the `offboardTx` docs spell out.
