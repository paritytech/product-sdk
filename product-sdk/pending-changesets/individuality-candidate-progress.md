---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Expose candidate progress as part of personhood state.**

`derivePersonhoodState` now reports the consecutive attended games remaining on `Candidate`, accounting for streak-weighted score accrual and absence resets.

**Breaking for candidate-state producers.** `gamesRemaining` is a required member of the exported `Candidate` variant, so hand-built states and exact fixtures must add it. Callers that only consume the derived state are unaffected.
