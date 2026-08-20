---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk-address": patch
"@parity/product-sdk": minor
---

**Fixes from review of the game and prize surface.**

Two correctness fixes, both changing behaviour a caller can see.

`readDrawRegistration` compared SS58 address strings, so the same account encoded under a
different network prefix did not match and a player who was entered in a draw read as not
entered. It now compares decoded public keys. Aliases keep the case-insensitive compare, since a
32-byte alias really is hex. `addressesEqual` in `@parity/product-sdk-address` had the
same limitation and is fixed the same way, so it now returns true for one account written
under two prefixes and still returns false, rather than throwing, for a malformed input.

**Behaviour change worth reading if you use `addressesEqual`.** It now compares the account, not
the encoding, so two SS58 strings for one key are equal even when their network prefixes differ.
Anything that relied on the old string compare to tell networks apart needs the prefix from
`ss58Decode` instead. The doc comment above the function said the opposite until now, which is
fixed too.

The correctness comes at a cost: a non-matching pair is decoded, roughly 20 microseconds, where an
exact match still short-circuits for nothing. That is fine per call and adds up in a loop, so
`publicKeysEqual` is now exported for that case. Decode the address you are searching for once
with `ss58Decode`, then compare keys against each candidate.

`confirmClaim` mapped every non-claiming draw to one of two phases, so a draw still assigning
winners was reported as though the lifecycle had swept the winner row, which reads as "the window
is over". It now reports the draw's real phase, and an unrecognised status variant fails on the
error channel instead of being reported as some existing phase, matching every other decode here.

**`claim_airdrop` has six gates, not five.** The prize asset must still be enabled for airdrops,
and the check was missing. That matters because `Pays::No` applies only on success, so a claim
this library green-lit and the chain refused cost the caller a fee. `readClaimEligibility` now
reads `Airdrop.SupportedAssets` and reports a `PrizeAssetDisabled` blocker.

**Breaking, before anything shipped:** `ClaimBlocker`'s `AttendedALaterGame` is now
`DidNotAttendThisGame`. The chain tests `last_attended_game == game_index`, so the blocker also
fires for a player who attended an earlier game or none at all, and the old name made a product
render "you played again" to someone who never played. Compare `lastAttendedGame` to the game
index to tell the three cases apart. `ClaimInputs` also gains a required `prizeAssetEnabled`.

`claimPrizeTx` returned `unknown`, so the usage in its own documentation did not typecheck when
passed to `submitAndWatch`. `ClaimChain` is now generic in the transaction type and the type is
inferred from the chain, so the documented call compiles with no type argument and no cast.

`readPrizeStatus`'s `NoGame` result now carries `lastGameIndex`, the game that just ended. That is
the index a late claim is keyed by, and it was being discarded even though the underlying read
returned it, forcing a second call on a second block.

`ClaimEligibility.window` now documents what it does: the draw's deadlines whenever the draw
exists, independent of whether this caller can claim. Read `claimable` for that.

`readClaimEligibility` no longer reports `PrizeAssetDisabled` for a draw whose event row is gone.
There is no asset id to look up there, so the gate is not applicable rather than failed, and
`DrawNotClaiming` already explains the situation. `ClaimInputs.prizeAssetEnabled` is
`boolean | null` for that reason.

The registration scan builds its comparison once instead of per entry, which halved the time on a
10,000-entry draw in a local measurement. It also makes a malformed account address fail the same
way every time, where before it threw only if the draw happened to contain an account entry and
answered "not registered" otherwise.

The `product-sdk-individuality` skill now documents the game, the draws and the claim, including
the six gates, the fee on a refused claim, and why the claim deadline is not a timestamp.
