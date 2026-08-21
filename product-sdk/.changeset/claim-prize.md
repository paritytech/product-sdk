---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Claim a prize: check whether you can, build the call, and confirm afterwards that it landed.**

```ts
import { readClaimEligibility, claimPrizeTx, confirmClaim } from "@parity/product-sdk-individuality";
import { submitAndWatch } from "@parity/product-sdk-tx";

const check = await readClaimEligibility(chain, {
    gameIndex, airdropIndex, registrant: { tag: "Account", accountAddress },
});
if (check.ok && check.value.claimable) {
    const tx = claimPrizeTx(chain, { gameIndex, airdropIndex, beneficiary });
    await submitAndWatch(tx, signer, { waitFor: "finalized" });
}
```

**`Game.claim_airdrop` has five gates and only two are about personhood.** A caller checking
recognition alone still gets `NotEligibleForAirdrop`, `NotClaiming`, `ClaimingWindowClosed` or
`NoSuchWinner` back from the chain with nothing local to explain them:

| Gate | On-chain error |
|---|---|
| recognized, or reached personhood | `Game.NotEligibleForAirdrop` |
| `last_attended_game == game_index` | `Game.NotEligibleForAirdrop` |
| the draw's status is `Claiming` | `Airdrop.NotClaiming` |
| now is before the draw's `end_time` | `Airdrop.ClaimingWindowClosed` |
| a `Winners` entry for this identity | `Airdrop.NoSuchWinner` |

`ClaimEligibility.blockers` carries **every** cause rather than the first found — a UI that says
"not recognized" while the window has also closed sends the player to fix the wrong thing.
`deriveClaimEligibility` is the pure form, for a caller that already holds a draw and a
participant.

**The binding deadline is not a timestamp.** Attending the next game overwrites
`last_attended_game` and closes the claim, usually well before the draw's `end_time`. So
`ClaimWindow` reports `closesOnNextAttendance` alongside `endTime`, because a countdown alone
misleads. The runtime's own comment contemplates relaxing `==` to `>=`, which would make that
`false` — the comparison is in one place for that reason.

**Resuming after a reload needs no subscription.** A successful claim *removes* the `Winners`
row, so `confirmClaim` re-reads it: a ticket still present means the claim has not landed, and
its absence means it has. That survives a reload, a dropped socket and a closed tab.

The one caveat is honest in the type: if the draw has also left `Claiming`, the row could have
been swept by the lifecycle instead, so the answer is `Unknown` rather than `Claimed`. Persist
the ticket when you claim — it is the only local evidence separating "claimed" from "never won".

**Submission stays with `@parity/product-sdk-tx`.** `claimPrizeTx` returns the unsigned PAPI
transaction, so retries, batching and fee estimation work without this package knowing about
them — the same split `withAsPerson` uses. For a person origin rather than a signed account, wrap
the signer with `withAsPerson`; the call is identical, because `claim_airdrop` accepts both and
derives the registration entry from whichever it got. The claim is `Pays::No`, so only a rejected
one costs a fee.

Two things worth knowing if you read these entries yourself. `Score.Participants` keys the alias
variant `Person` where `Airdrop`'s registration entry calls it `Alias` — same identity, two
spellings, and the wrong one reads nothing and looks like a missing record. And
`readClaimEligibility` takes `now` in Unix **seconds**, defaulting to the device clock; pass the
chain's own time if you have it, since a clock minutes fast will call a live window closed.

**Also corrected:** `AirdropOutcome.NotWon` was documented as meaning "not drawn yet" or "did not
win". It has a third meaning — **won and already claimed**, since claiming removes the row. The
doc now says so.
