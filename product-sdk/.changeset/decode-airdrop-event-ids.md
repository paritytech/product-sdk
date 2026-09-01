---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Decode a `PeopleAirdrops` draw event id back to its draw index.**

`parsePeopleAirdropsEventId(eventId)` is the inverse of `peopleAirdropsEventId`. It returns the `u64` draw index, or `null` for anything that is not a `PeopleAirdrops` id — a `Game` id, a foreign base, a malformed string. `null` rather than a throw because `Airdrop.Events` holds both schedulers, so a caller sweeping it with `getEntries()` meets foreign ids as a matter of course.

The package could previously only derive ids forward, from indices the caller already held. That holds for the `Game` path, which has a per-game count to enumerate from, but not for `PeopleAirdrops`, whose ids only arrive from that shared map.
