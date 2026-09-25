---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Expose the participant record behind a resolved personhood state.**

The `Resolved` arm of `PersonhoodResult` now carries `participant`, the decoded `Score.Participants` record the state was derived from, or `null` when the account has none. It holds the fields the state and the metrics summarize away: the streak, the attendance history, the recognition, `lastAttendedGame` and whether personhood was reached, so a product no longer reads the entry a second time to get them.

`PersonhoodParticipant` also gains `hasEverReachedPersonhood`, which stays `true` after the score falls back below the threshold, decoded from the new `has_ever_reached_personhood` member of `RawParticipant`.

**Breaking for implementors.** `participant` is a required member of the `Resolved` arm, `hasEverReachedPersonhood` of `PersonhoodParticipant`, and `has_ever_reached_personhood` of `RawParticipant`, so hand-built values and test doubles must add them. Callers are unaffected, and values decoded by `toPersonhoodParticipant` from a real `Score.Participants` read already carry them.
