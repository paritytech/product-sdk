---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Read the current game: its phase, the deadline that phase runs to, and what is scheduled next.**

```ts
import { readCurrentGame } from "@parity/product-sdk-individuality";

const chain = await getChainAPI("paseo");
const result = await readCurrentGame(chain);
if (!result.ok) return;

if (result.value.tag === "Running") {
    const { index, phase, nextDeadline, airdropsScheduled } = result.value.game;
} else {
    // No game right now — the chain's normal state between games.
    const next = result.value.upcoming[0];
}
```

**No game running is a success value, not an error.** One game exists at a time and each is
killed when it ends, so `BetweenGames` is the state the chain is in most of the time. It carries
`lastGameIndex` — the counter only moves when a game is *created*, so it still names the game
that just ended, which is the index a prize from that game is claimed against. It is `null`
before any game has ever existed, because games are numbered from 1.

**The phase comes from the chain's `GameState`, never from comparing timestamps to a clock.**
Transitions run in an offchain worker's own time, so a boundary can be in the past while its
phase is still current. `nextDeadline` is selected from the stored boundary matching the phase,
and is `null` for `PlayerProcess` and `Cancelling`, which end when their work finishes rather
than at a time.

**Stored boundaries and derived ones are kept apart on purpose.** A running game carries the
boundaries it was created with, and `CurrentGame` reports those and never re-derives them —
governance can change `Game.StoredPhaseDurations` afterwards, at which point a re-derivation
would contradict the chain's own stored values. An upcoming schedule stores only its play time,
so its boundaries have nowhere to come from *but* derivation: `GameSchedulePreview.timeline`
mirrors the runtime's `GameTimes` trait, saturating arithmetic included, and is documented as a
projection that moves if the durations do. `gameTimeline` is exported for callers doing their
own reads.

Also exported: `readCurrentGame` reports the `durations` its projections were built with, so a
caller can tell which source they came from — `Game.StoredPhaseDurations` when governance has
set an override, and the `Game.DefaultPhaseDurations` constant otherwise. The constant is read
only in the fallback case, which keeps the one un-block-pinned value in this read out of the
common path. PAPI serves constants from the client's current runtime rather than from a block,
so it can only disagree with the pinned block across a runtime upgrade landing mid-read.

Two counts that look interchangeable and are not. `CurrentGame.airdropsScheduled` is how many
draws the game *actually* got — scheduling stops at the first failure — and is the count event
ids may be derived from. `GameSchedulePreview.airdrops` is what a schedule *asks* for, useful
for showing a prize before the game exists and wrong for deriving ids.

**The game surface is paseo-only for now, and the descriptors say so.** The committed devnet
metadata predates the multi-airdrop game work: its `GameSchedule` carries a single optional
`airdrop_prize` rather than a list of draws, its `GameInfo` has no `airdrops_scheduled`, its
`PhaseDurationValues` still carries the `airdrop_claim_window` that moved onto each draw, and
its `Game.airdrop_event_id_base` is 28 bytes to paseo's 27 — a different event-id layout
altogether. A devnet client therefore fails `GameChain` structurally, and the compile-time
contract in `@parity/product-sdk` asserts that failure deliberately, so a re-pinned devnet
breaks the assertion instead of leaving the read quietly unsupported.

That last divergence is worth knowing if you derive event ids yourself: nothing in the type
system catches it, because PAPI's `SizedHex<N>` erases `N` and a 28-byte base satisfies every
signature a 27-byte one does. The length check in `gameAirdropEventId` is the whole guard, which
is why it throws rather than padding or truncating.
